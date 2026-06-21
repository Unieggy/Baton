/**
 * RelayIDE — Compressor Engine (headless test harness)
 * ----------------------------------------------------
 * Goal: take the raw state of a "broken" workspace, compress the situation
 * into a strict JSON handoff manifest using the user's LOCAL `claude` CLI in
 * headless print mode (zero API cost — rides the existing Claude Code
 * subscription/OAuth, no API key, no per-token bill), and write the result
 * to `.relay_handoff.json`.
 *
 * Pipeline:
 *   1. extractWorkspaceState()  — git diff + code skeleton + stderr trace
 *   2. assemblePrompt()         — concat into a strict instruction prompt
 *   3. COMPRESS_BACKEND()       — pluggable provider call (Claude by default)
 *   4. scrubJson()              — pull the pure JSON object out of the reply
 *   5. writeHandoff()           — persist `.relay_handoff.json`
 *
 * Run with:  npx ts-node compressor.ts
 *
 * Only Node built-ins are used (child_process, fs, path) so the only dev
 * deps you need are `ts-node` and `@types/node`.
 */

import * as fs from "fs";
import * as path from "path";
import { captureWorkspace, formatSkeletons } from "./extract";
import { CompressBackend } from "./contracts";
import { claudeAdapter } from "./adapters/claude";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Workspace we are analysing. Defaults to CWD; override via argv[2]. */
const WORKSPACE_DIR = path.resolve(process.argv[2] || process.cwd());

/** Mock terminal-crash log used by this test harness in place of live stderr. */
const MOCK_STDERR_FILE = path.join(WORKSPACE_DIR, "mock-stderr.log");

/** Where the compressed handoff is written. */
const HANDOFF_FILE = path.join(WORKSPACE_DIR, ".relay_handoff.json");

/**
 * The model we want the *next* coding session to resume on (a label written
 * into the manifest), and the model the `claude` CLI uses to do the
 * compression. Keep them separable: you may want a cheap/fast model to
 * compress and a stronger one to resume coding.
 */
const TARGET_MODEL = process.env.RELAY_TARGET_MODEL || "claude-opus-4-8";
const COMPRESSOR_MODEL =
  process.env.RELAY_COMPRESSOR_MODEL || "claude-sonnet-4-6";

/**
 * The compression BACKEND — which provider does the summarization. Pluggable so
 * compression can run on whatever provider is currently UP (the primary may be
 * the very thing that's rate-limited). Claude is the default, NOT a dependency;
 * register more backends here as their adapters land (gemini, ollama, …).
 */
const COMPRESS_BACKEND_NAME = process.env.RELAY_COMPRESS_BACKEND || "claude";
const BACKENDS: Record<string, CompressBackend> = {
  claude: claudeAdapter.compress,
};
const COMPRESS_BACKEND: CompressBackend =
  BACKENDS[COMPRESS_BACKEND_NAME] ?? claudeAdapter.compress;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkspaceState {
  gitDiff: string;
  codeSkeleton: string;
  stderrTrace: string;
}

/**
 * The expanded handoff schema. The guiding principle for every field: include
 * only what CANNOT be re-derived from the workspace on disk (intent, progress,
 * decisions, pointers) and exclude raw content (file bodies, full diffs) — the
 * next agent reads those lazily from disk. This keeps the manifest information-
 * dense but small (~1-2K tokens vs. the ~120K transcript it replaces).
 */
interface FocusFile {
  path: string; // repo-relative path the next agent should open first
  role: string; // why this file matters to the task
  state: string; // its current condition (e.g. "has the bug at line 8", "read-only ref")
}

interface Decision {
  choice: string; // an architectural/implementation choice already made
  why: string; // the rationale — so the next agent doesn't relitigate it
}

interface HandoffTask {
  goal: string; // the objective, enough for a cold start
  status: string; // e.g. "in_progress" | "blocked"
  progress: string[]; // what is already done
  remaining: string[]; // what is left to do
  next_action: string; // the single concrete next step
}

export interface HandoffManifest {
  target_model: string;
  task: HandoffTask;
  focus_files: FocusFile[]; // the curated index that prevents whole-repo exploration
  decisions: Decision[];
  constraints: string[]; // invariants / hard-won rules the next agent must respect
  open_questions: string[]; // known unknowns to focus the first moves
  cognitive_negative_memory: string; // explicit "do NOT" guidance from the failure
  // The CLI may add extra keys; we keep them but require the above.
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Step 1 — Local Data Extraction
// ---------------------------------------------------------------------------

/**
 * Assemble the compressor's view of the workspace: the shared `captureWorkspace`
 * snapshot (git diff + skeletons — same logic the live monitor uses) plus the
 * crash trace. The stderr is compressor-only: it's the freeze-time artifact the
 * monitor has no reason to track, so it's read here, not in the shared module.
 */
function extractWorkspaceState(workspaceDir: string = WORKSPACE_DIR): WorkspaceState {
  const snapshot = captureWorkspace(workspaceDir);

  // Stderr (mocked from disk for this harness) — the terminal crash trace.
  // Derived from the workspace so the orchestrator can point it at any dir.
  const stderrFile =
    workspaceDir === WORKSPACE_DIR
      ? MOCK_STDERR_FILE
      : path.join(workspaceDir, "mock-stderr.log");
  let stderrTrace = "(no stderr captured)";
  if (fs.existsSync(stderrFile)) {
    stderrTrace = fs.readFileSync(stderrFile, "utf-8").trim();
  }

  return {
    gitDiff: snapshot.gitDiff || "(no unstaged changes)",
    codeSkeleton: formatSkeletons(snapshot.skeletons),
    stderrTrace,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — Prompt Assembler
// ---------------------------------------------------------------------------

/**
 * Build the strict compression prompt. We are explicit about output shape so
 * the scrubber has the best chance of finding a single clean JSON object.
 */
function assemblePrompt(
  state: WorkspaceState,
  targetModel: string = TARGET_MODEL
): string {
  return `You are RelayIDE's context compressor. A coding session crashed or hit a rate limit mid-task. Below is the raw workspace state. Analyse the failure and produce a compressed handoff for a FRESH agent that must resume the work in the SAME workspace.

The fresh agent still has the full repo on disk — it can run git, read files, and grep anytime. So do NOT restate file contents or the diff. Instead, capture only what it CANNOT recover from disk: the intent, the progress so far, the decisions already made and why, the rules it must respect, and a curated pointer to the few files that matter (so it does not have to explore the whole repo).

Respond with ONE JSON object and NOTHING ELSE — no prose, no markdown fences. Use EXACTLY this shape:
{
  "target_model": "${targetModel}",
  "task": {
    "goal": "string — the objective, 1-3 sentences, enough to resume cold",
    "status": "in_progress | blocked",
    "progress": ["string — a thing already completed", "..."],
    "remaining": ["string — a thing still to do", "..."],
    "next_action": "string — the single concrete step to take first"
  },
  "focus_files": [
    { "path": "repo-relative path", "role": "why this file matters", "state": "its current condition, e.g. 'has the bug at line 8' or 'read-only reference'" }
  ],
  "decisions": [
    { "choice": "an implementation/design choice already made", "why": "the rationale, so it is not relitigated" }
  ],
  "constraints": ["string — an invariant or hard-won rule to respect, e.g. 'migrations are append-only'"],
  "open_questions": ["string — a known unknown to resolve first"],
  "cognitive_negative_memory": "string — explicit, imperative 'do NOT' instructions derived from the error/stderr (e.g. 'Do not re-run the migration; the age column may already be partially applied — check the schema first.')"
}

Rules:
- Derive focus_files from the changed files in the diff plus any file they critically depend on. Keep it to the few that matter; do NOT list the whole repo.
- progress/remaining/decisions: infer from the diff and skeleton what was being built and how far it got.
- Arrays may be empty if genuinely nothing applies, but prefer to populate them — a richer handoff means less re-exploration.
- Keep every string tight. The whole point is a small, dense manifest.

=== GIT DIFF ===
${state.gitDiff}

=== CODE SKELETON (structure only, logic stripped) ===
${state.codeSkeleton}

=== STDERR / CRASH TRACE ===
${state.stderrTrace}

Output the JSON object now.`;
}

// ---------------------------------------------------------------------------
// Step 3 — Compression backend (pluggable; provider-specific code lives in
// ./adapters/*). The headless model call is no longer hardcoded here: `main`
// selects a `CompressBackend` (Claude by default) and hands it the prompt, so
// any provider can perform the compression. See adapters/claude.ts for the
// `claude -p` implementation.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Step 4 — JSON Scrubber
// ---------------------------------------------------------------------------

/**
 * Extract and parse the first complete JSON object from a possibly-chatty
 * model reply. Handles: ```json fenced blocks, leading/trailing prose, and
 * stray text after the object. Uses brace-balancing (string-aware) rather than
 * a naive regex so nested objects don't trip it up.
 */
function scrubJson(raw: string): HandoffManifest {
  let text = raw.trim();

  // 1. If there's a fenced code block, prefer its contents.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // 2. Walk to the first '{' and brace-match to its partner, ignoring braces
  //    that appear inside string literals.
  const start = text.indexOf("{");
  if (start === -1) {
    throw new Error(`No JSON object found in CLI output:\n${raw}`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) {
    throw new Error(`Unbalanced JSON object in CLI output:\n${raw}`);
  }

  const jsonSlice = text.slice(start, end + 1);
  let parsed: HandoffManifest;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (e: any) {
    throw new Error(`Failed to parse extracted JSON: ${e.message}\n${jsonSlice}`);
  }

  // Validate the contract we asked the model to honour.
  const required = ["target_model", "task", "cognitive_negative_memory"];
  const missing = required.filter((k) => !(k in parsed));
  if (missing.length) {
    throw new Error(
      `Handoff manifest missing required keys: ${missing.join(", ")}`
    );
  }
  // task is the load-bearing nested object — sanity-check its core fields.
  const task = parsed.task as Partial<HandoffTask> | undefined;
  if (!task || typeof task.goal !== "string") {
    throw new Error(`Handoff manifest 'task' is missing or has no 'goal':\n${jsonSlice}`);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Step 5 — Output
// ---------------------------------------------------------------------------

function writeHandoff(
  manifest: HandoffManifest,
  handoffFile: string = HANDOFF_FILE
): void {
  fs.writeFileSync(handoffFile, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Library entrypoint — the full pipeline as one call
// ---------------------------------------------------------------------------

export interface CompressionRequest {
  /** Workspace to analyse. Defaults to the module's WORKSPACE_DIR (CWD/argv). */
  workspaceDir?: string;
  /**
   * Which provider performs the summarization. The orchestrator injects a
   * backend from a provider that is currently UP — the primary may be the very
   * thing that's rate-limited. Defaults to the env-selected backend.
   */
  backend?: CompressBackend;
  /** Model the backend uses to compress. Defaults to COMPRESSOR_MODEL. */
  compressorModel?: string;
  /** Model label written into the manifest for the resuming session. */
  targetModel?: string;
  /** Where to persist the manifest. Defaults to <workspace>/.relay_handoff.json. */
  handoffPath?: string;
}

/**
 * Run the whole compression pipeline (extract → assemble → compress → scrub →
 * write) and return the validated manifest. This is the seam the orchestrator
 * calls at freeze time; the CLI `main()` below is just a thin wrapper over it.
 */
export async function runCompression(
  req: CompressionRequest = {}
): Promise<HandoffManifest> {
  const workspaceDir = req.workspaceDir
    ? path.resolve(req.workspaceDir)
    : WORKSPACE_DIR;
  const backend = req.backend ?? COMPRESS_BACKEND;
  const compressorModel = req.compressorModel ?? COMPRESSOR_MODEL;
  const targetModel = req.targetModel ?? TARGET_MODEL;
  const handoffPath =
    req.handoffPath ?? path.join(workspaceDir, ".relay_handoff.json");

  const state = extractWorkspaceState(workspaceDir);
  const prompt = assemblePrompt(state, targetModel);
  const rawReply = await backend(prompt, {
    model: compressorModel,
    cwd: workspaceDir,
  });
  const manifest = scrubJson(rawReply);
  writeHandoff(manifest, handoffPath);
  return manifest;
}

// ---------------------------------------------------------------------------
// CLI — `npx tsx compressor.ts [workspaceDir]`
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[relay] workspace : ${WORKSPACE_DIR}`);
  console.log(
    `[relay] compressing via ${COMPRESS_BACKEND_NAME} (${COMPRESSOR_MODEL})…`
  );

  const manifest = await runCompression();

  console.log(`\n[relay] ✅ wrote ${HANDOFF_FILE}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}

// Only run the pipeline when invoked directly — importing this module (e.g. from
// the orchestrator) must NOT kick off a compression as a side effect.
if (require.main === module) {
  main().catch((err) => {
    console.error("\n[relay] ❌ compression failed:\n", err.message || err);
    process.exit(1);
  });
}
