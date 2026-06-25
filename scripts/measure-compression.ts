/**
 * Measure the Stage-1 compression: raw conversation -> evidence after the
 * git+regex capture. This is the "facts, not chat" boundary.
 *
 *   npx tsx scripts/measure-compression.ts [transcript.jsonl] [repoDir]
 *
 * Tokens are estimated the same way the packet metrics are (~4 chars/token).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { captureWorkspace, formatSkeletons } from "../extract";

const approxTokens = (s: string): number => Math.ceil(s.length / 4);
const fmt = (n: number): string => n.toLocaleString("en-US");

/** Pull the human-readable message text out of a Claude Code transcript. */
function conversationText(file: string): string {
  const parts: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: { message?: { content?: unknown } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const content = row.message?.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (typeof block.text === "string") parts.push(block.text);
        else if (block.type === "tool_result" && typeof block.content === "string")
          parts.push(block.content);
        else parts.push(JSON.stringify(block)); // tool_use inputs, etc.
      }
    }
  }
  return parts.join("\n");
}

/** Biggest .jsonl in this project's Claude transcript folder. */
function biggestTranscript(): string {
  const dir = join(
    homedir(),
    ".claude/projects/-Users-cheng-Desktop-Projects-vscodebased-aihack"
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f));
  files.sort((a, b) => statSync(b).size - statSync(a).size);
  if (!files[0]) throw new Error(`No transcripts in ${dir}`);
  return files[0];
}

const transcript = process.argv[2] ?? biggestTranscript();
const repo = process.argv[3] ?? process.cwd();

// 1) The raw conversation — what a native model switch would re-ingest.
const convo = conversationText(transcript);
const convoTokens = approxTokens(convo);

// 2) The evidence AFTER the deterministic git + regex capture.
const snap = captureWorkspace(repo);
const skeleton = formatSkeletons(snap.skeletons);
const evidence = `${snap.gitDiff}\n${skeleton}`;
const diffTokens = approxTokens(snap.gitDiff);
const skeletonTokens = approxTokens(skeleton);
const evidenceTokens = diffTokens + skeletonTokens;

const reduction = convoTokens > 0 ? (1 - evidenceTokens / convoTokens) * 100 : 0;

console.log(`\ntranscript : ${transcript}`);
console.log(`repo       : ${repo}\n`);
console.log(`RAW CONVERSATION (what a native switch re-feeds)`);
console.log(`  ${fmt(convo.length)} chars  ~  ${fmt(convoTokens)} tokens\n`);
console.log(`EVIDENCE AFTER git + regex capture`);
console.log(`  git diff       : ~ ${fmt(diffTokens)} tokens  (${snap.stats.filesChanged} files)`);
console.log(`  regex skeleton : ~ ${fmt(skeletonTokens)} tokens  (${snap.skeletons.length} files)`);
console.log(`  evidence total : ~ ${fmt(evidenceTokens)} tokens\n`);
console.log(
  `STAGE-1 REDUCTION (conversation -> evidence): ${reduction.toFixed(2)}%`
);
console.log(
  `  ${fmt(convoTokens)} -> ${fmt(evidenceTokens)} tokens, before the LLM distills at all.\n`
);
