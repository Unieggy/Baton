/**
 * Baton tracking self-check (real agents).
 *
 * Boots a real-agent server, creates a session, starts Claude, and polls the
 * event stream to verify — with evidence — that Baton actually:
 *   1. spawns + tracks Claude   (process.started/terminal.output, agent=claude)
 *   2. fires the handoff        (limit.detected → handoff.created → agent.switched)
 *   3. spawns + monitors Codex  (process.started, agent=codex)
 *
 *   npx tsx scripts/verify-tracking.ts
 *
 * Needs claude + codex logged in. Uses a prompt that makes Claude emit the
 * rate-limit phrase so the auto-handoff trigger fires; falls back to a manual
 * handoff so the Codex leg is still verified.
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const WORKSPACE = path.join(ROOT, "demo-repo");
const PORT = Number(process.env.PORT ?? 4123);
const BASE = `http://127.0.0.1:${PORT}`;
const TASK =
  "Output exactly this single line and nothing else: Stopping: API rate limit reached (429), too many requests.";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok });
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function jget(p: string): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(BASE + p);
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}
async function jpost(p: string, body: unknown = {}): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(BASE + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}
const eventsOf = async (id: string): Promise<any[]> =>
  (await jget(`/api/sessions/${id}/events`)).body?.events ?? [];

async function waitFor(
  id: string,
  pred: (e: any[]) => boolean,
  ms = 45000
): Promise<any[]> {
  const start = Date.now();
  let evs: any[] = [];
  while (Date.now() - start < ms) {
    evs = await eventsOf(id);
    if (pred(evs)) return evs;
    process.stdout.write(".");
    await delay(1000);
  }
  return evs;
}
const has = (e: any[], type: string, agent?: string) =>
  e.some((x) => x.type === type && (agent ? x.agent === agent : true));

async function main(): Promise<void> {
  console.log(b("\n== Baton tracking self-check — REAL agents ==\n"));

  const server = spawn("npx", ["tsx", "apps/server/src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), RELAY_FAKE_AGENTS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  process.on("exit", () => { try { server.kill("SIGTERM"); } catch { /* */ } });

  // 1. server up
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    up = (await jget("/health")).status === 200;
    if (!up) await delay(300);
  }
  check("server boots (real agents)", up);
  if (!up) { console.log(log); process.exit(1); }

  // 2. session
  const created = await jpost("/api/sessions", {
    goal: TASK,
    verificationCommand: "npm test",
    workspaceDir: WORKSPACE,
  });
  const sid = created.body?.id;
  check("session created", created.status === 201 && !!sid, sid ?? JSON.stringify(created.body));
  if (!sid) { console.log(log); process.exit(1); }

  // 3. start claude
  const started = await jpost(`/api/sessions/${sid}/claude/start`, {});
  check("claude/start accepted", started.status === 202);

  // 4. tracking Claude
  process.stdout.write("\n  watching Claude");
  let evs = await waitFor(sid, (e) => has(e, "process.started", "claude"));
  console.log("");
  check("Baton SPAWNS + TRACKS Claude (process.started, agent=claude)", has(evs, "process.started", "claude"));
  evs = await waitFor(sid, (e) => has(e, "terminal.output"), 15000);
  check("Baton captures Claude output (terminal.output)", has(evs, "terminal.output"));

  // 5. handoff (auto-trigger; fall back to manual)
  process.stdout.write("\n  watching for handoff");
  evs = await waitFor(sid, (e) => has(e, "agent.switched") || has(e, "handoff.created"), 30000);
  console.log("");
  const autoFired = has(evs, "limit.detected");
  check("auto rate-limit trigger fired (limit.detected)", autoFired);
  if (!has(evs, "handoff.created")) {
    // Trigger may not have caught it before Claude exited — force a handoff so
    // we can still verify the Codex leg.
    console.log("  (auto-handoff not seen — forcing a manual handoff to verify Codex)");
    await jpost(`/api/sessions/${sid}/handoff`, {});
    await jpost(`/api/sessions/${sid}/codex/start`, {});
    evs = await waitFor(sid, (e) => has(e, "agent.switched") || has(e, "process.started", "codex"), 25000);
  }
  check("handoff packet built (handoff.created)", has(evs, "handoff.created"));
  check("switched to Codex (agent.switched)", has(evs, "agent.switched"));

  // 6. monitoring Codex
  process.stdout.write("\n  watching Codex");
  evs = await waitFor(sid, (e) => has(e, "process.started", "codex"), 30000);
  console.log("");
  check("Baton SPAWNS + MONITORS Codex (process.started, agent=codex)", has(evs, "process.started", "codex"));

  // summary
  const pass = results.filter((x) => x.ok).length;
  console.log(b(`\n== RESULT: ${pass}/${results.length} checks passed ==`));
  console.log("timeline: " + [...new Set(evs.map((x) => `${x.type}${x.agent ? `(${x.agent})` : ""}`))].join(" → "));
  if (pass < results.length) console.log(r("\nServer log tail:\n") + log.split("\n").slice(-12).join("\n"));
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error(r("error: " + (e?.message ?? e))); process.exit(1); });
