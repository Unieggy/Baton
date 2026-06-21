import assert from "node:assert/strict";
import test from "node:test";
import { RelayEvent } from "../packages/shared";
import {
  activeAgent,
  activeSupportsInput,
  currentActivity,
  derivePhase,
  eventLine,
} from "../ui/src/live";

function event(type: string, payload: Record<string, unknown>) {
  return RelayEvent.parse({
    id: `event-${type}`,
    sessionId: "session-1",
    type,
    timestamp: "2026-06-21T00:00:00.000Z",
    payload,
  });
}

test("live UI renders the orchestrator's route-target payloads", () => {
  const switched = event("agent.switched", {
    from: { provider: "claude", model: "claude-opus" },
    to: { provider: "codex", model: "gpt-5-codex" },
  });

  assert.equal(
    eventLine(switched).value,
    "↪ baton: switched claude → codex"
  );
  assert.equal(activeAgent([switched]), "codex");
});

test("live UI reads nested handoff metrics and process argument arrays", () => {
  const handoff = event("handoff.created", {
    metrics: { reductionPercent: 93.4 },
  });
  const started = event("process.started", {
    command: "npm",
    args: ["test", "--", "migration"],
  });

  assert.equal(eventLine(handoff).value, "↪ baton: packet ready · −93%");
  assert.equal(eventLine(started).value, "$ npm test -- migration");
});

test("live UI treats a second started agent as a completed switch", () => {
  const claude = event("agent.started", {
    provider: "claude",
    model: "claude-sonnet",
  });
  const handoff = event("handoff.created", {
    metrics: { reductionPercent: 91 },
  });
  const codex = event("agent.started", {
    provider: "codex",
    model: "gpt-5-codex",
  });

  assert.equal(derivePhase([claude, handoff]), "switching");
  assert.equal(derivePhase([claude, handoff, codex]), "resumed");
  assert.equal(activeAgent([claude, handoff, codex]), "codex");
});

test("live UI distinguishes a cold launch from a packet resume", () => {
  const base = {
    id: "evt-launch",
    sessionId: "s1",
    type: "agent.launching",
    timestamp: new Date().toISOString(),
    payload: { target: "claude" },
  };
  assert.equal(eventLine(base).value, "$ claude launch");
  assert.equal(
    eventLine({ ...base, payload: { target: "codex", resumed: true } }).value,
    "$ codex resume --packet"
  );
});

test("live UI renders an explicit terminal failure", () => {
  const event = {
    id: "evt-failed",
    sessionId: "s1",
    type: "session.failed",
    timestamp: new Date().toISOString(),
    payload: { error: "verification failed (exit 1)" },
  };
  assert.deepEqual(eventLine(event), {
    kind: "fail",
    value: "✖ session failed — verification failed (exit 1)",
  });
});

test("live UI exposes input only when the launched adapter supports it", () => {
  const oneShot = event("agent.launching", {
    target: "codex",
    supportsInput: false,
  });
  const interactive = event("agent.launching", {
    target: "claude",
    supportsInput: true,
  });
  assert.equal(activeSupportsInput([oneShot]), false);
  assert.equal(activeSupportsInput([oneShot, interactive]), true);
});

test("live UI derives one calm current-activity line from semantic events", () => {
  const output = event("terminal.output", {
    chunk: "\u001b[32mreading schema\u001b[0m\nediting migration.ts\n",
  });
  const changed = event("file.changed", { path: "demo-repo/migrate.ts" });
  const handoff = event("handoff.distilling", {});
  const resumed = event("agent.switched", { from: "claude", to: "codex" });

  assert.equal(currentActivity([], "Waiting"), "Waiting");
  assert.equal(currentActivity([output]), "editing migration.ts");
  assert.equal(
    currentActivity([output, changed]),
    "Editing demo-repo/migrate.ts"
  );
  assert.equal(
    currentActivity([output, changed, handoff]),
    "Compiling the smallest useful context"
  );
  assert.equal(
    currentActivity([output, changed, handoff, resumed]),
    "Codex resumed from the handoff"
  );
});
