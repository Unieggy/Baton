/**
 * Relay server — pseudo-terminal (PTY) runner
 * -------------------------------------------
 * The interactive sibling of `process-runner.ts`. Where the process runner pipes
 * a non-TTY `child_process` (fine for one-shot CLIs and the verifier), this runs
 * a program inside a real PTY via `node-pty`, so interactive TUIs — the actual
 * `claude` / `codex` programs, including their approval prompts — render and
 * behave exactly as in a terminal.
 *
 * It emits the SAME canonical events as the process runner
 * (`process.started`, `terminal.output`, `process.exited`), so the broadcaster,
 * event-store, and the orchestrator's limit-detection observers consume a PTY
 * run without any provider-specific changes. A PTY merges stdout+stderr into one
 * stream, so output is emitted as `stream: "stdout"` carrying raw bytes (ANSI
 * escapes included) for xterm.js to render faithfully.
 */

import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  RelayEvent,
  type AgentId,
  type RelayEventSink,
} from "../../../packages/shared";

export type { RelayEventSink } from "../../../packages/shared";

export interface PtyRunOptions {
  sessionId: string;
  command: string;
  args?: string[];
  /** Working directory (must be an existing directory). */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Optional agent tag stamped onto every emitted event. */
  agent?: AgentId;
  cols?: number;
  rows?: number;
}

export interface PtyResult {
  exitCode: number | null;
  signal: number | null;
  durationMs: number;
}

export interface RelayPtyHandle {
  readonly pid: number | undefined;
  /** Forward keystrokes / input to the PTY. */
  write(data: string): void;
  /** Resize the PTY so the TUI reflows. */
  resize(cols: number, rows: number): void;
  /** Request termination (default SIGTERM). */
  terminate(signal?: string): void;
  /** Resolves once the program has exited and the exit event was emitted. */
  readonly done: Promise<PtyResult>;
}

/**
 * Spawn `command` in a PTY and stream its lifecycle to `onEvent`. Throws
 * synchronously only if `cwd` is not an existing directory.
 */
export function startPty(
  opts: PtyRunOptions,
  onEvent: RelayEventSink
): RelayPtyHandle {
  assertDirectory(opts.cwd);

  const startedAt = Date.now();
  let seq = 0;
  let settled = false;

  const emit = (type: string, payload: Record<string, unknown>): void => {
    onEvent(
      RelayEvent.parse({
        id: `evt-${randomUUID()}`,
        sessionId: opts.sessionId,
        type,
        timestamp: new Date().toISOString(),
        ...(opts.agent ? { agent: opts.agent } : {}),
        payload,
      })
    );
  };

  const child = pty.spawn(opts.command, opts.args ?? [], {
    name: "xterm-256color",
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 30,
    cwd: opts.cwd,
    env: (opts.env ?? process.env) as Record<string, string>,
  });

  emit("process.started", {
    command: opts.command,
    args: opts.args ?? [],
    cwd: opts.cwd,
    pid: child.pid ?? null,
  });

  child.onData((chunk: string) => {
    emit("terminal.output", { stream: "stdout", chunk, seq: seq++ });
  });

  let resolveDone!: (r: PtyResult) => void;
  const done = new Promise<PtyResult>((resolve) => {
    resolveDone = resolve;
  });

  child.onExit(({ exitCode, signal }) => {
    if (settled) return;
    settled = true;
    const result: PtyResult = {
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      durationMs: Date.now() - startedAt,
    };
    emit("process.exited", { ...result });
    resolveDone(result);
  });

  return {
    pid: child.pid,
    write(data: string): void {
      if (settled) return;
      child.write(data);
    },
    resize(cols: number, rows: number): void {
      if (settled || cols <= 0 || rows <= 0) return;
      try {
        child.resize(cols, rows);
      } catch {
        /* PTY already gone */
      }
    },
    terminate(signal: string = "SIGTERM"): void {
      if (settled) return;
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    },
    done,
  };
}

function assertDirectory(dir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`pty cwd does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`pty cwd is not a directory: ${dir}`);
  }
}
