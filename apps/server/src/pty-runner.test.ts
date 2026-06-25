/**
 * PTY runner smoke test — spawns a trivial program in a real PTY and asserts the
 * canonical lifecycle events (so the broadcaster/store/orchestrator can consume a
 * PTY run exactly like a child_process run).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { startPty } from "./pty-runner";
import type { RelayEvent } from "../../../packages/shared/events";

test("startPty streams output and exits with canonical events", async () => {
  const events: RelayEvent[] = [];
  const handle = startPty(
    {
      sessionId: "pty-test",
      command: "/bin/echo",
      args: ["hello-from-pty"],
      cwd: process.cwd(),
      agent: "claude",
    },
    (e) => events.push(e)
  );

  const result = await handle.done;
  assert.equal(result.exitCode, 0);

  const types = events.map((e) => e.type);
  assert.ok(types.includes("process.started"));
  assert.ok(types.includes("process.exited"));

  const output = events
    .filter((e) => e.type === "terminal.output")
    .map((e) => String((e.payload as { chunk?: string }).chunk ?? ""))
    .join("");
  assert.match(output, /hello-from-pty/);
  // Every event is stamped with the agent tag.
  assert.ok(events.every((e) => e.agent === "claude"));
});

test("startPty throws synchronously on a missing cwd", () => {
  assert.throws(
    () =>
      startPty(
        { sessionId: "x", command: "/bin/echo", cwd: "/no/such/dir" },
        () => {}
      ),
    /cwd does not exist/
  );
});
