/**
 * RelayIDE — Claude provider adapter
 * ----------------------------------
 * Claude is ONE provider among many — not a home base. All Claude-specific
 * behavior lives here, behind the neutral `ProviderAdapter` interface, so the
 * orchestrator never special-cases it.
 *
 * Step 1 implements `compress` (headless `claude -p`, the zero-cost backend
 * that rides the user's existing Claude Code subscription). `launch` and the
 * `LiveSession` it returns are implemented in step 2 (injection / resumption).
 */

import { spawn } from "child_process";
import {
  CompressBackend,
  LaunchOptions,
  LiveSession,
  ProviderAdapter,
} from "../contracts";

/**
 * Headless print-mode compression via the local `claude` CLI.
 *
 * Zero cost: rides the user's Claude Code session (OAuth/subscription) — no API
 * key, no per-token bill — and is already installed wherever RelayIDE runs.
 *
 * spawn + stdin (not `echo '<prompt>' | claude`): diffs/stderr are full of
 * quotes, newlines, $ and backticks; a shell string would mangle them. Writing
 * to the child's stdin is binary-safe and unbounded.
 *
 * --output-format json wraps the reply as { "result": "...", … }; we return
 * `.result`, falling back to raw stdout if the envelope shape ever changes.
 */
export const claudeCompress: CompressBackend = (prompt, opts) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", "--output-format", "json", "--model", opts.model],
      { cwd: opts.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "ENOENT"
          ? new Error(
              "`claude` CLI not found on PATH. Install Claude Code and ensure `claude` is runnable."
            )
          : err
      );
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}.\nstderr:\n${stderr}`));
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        resolve(typeof envelope.result === "string" ? envelope.result : stdout);
      } catch {
        resolve(stdout);
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });

/**
 * The Claude adapter. `compress` is live now; `launch` — booting a resumable
 * Claude session seeded with a manifest — lands in step 2.
 */
export const claudeAdapter: ProviderAdapter = {
  provider: "claude",
  compress: claudeCompress,
  launch(_opts: LaunchOptions): Promise<LiveSession> {
    throw new Error(
      "claudeAdapter.launch not implemented yet (step 2 — injection / resumption)."
    );
  },
};
