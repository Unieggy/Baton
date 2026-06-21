import {
  HandoffPacket,
  RelayEvent,
  type HandoffPacket as HandoffPacketType,
  type RelayEvent as RelayEventType,
} from "../../packages/shared";

export const demoPacket: HandoffPacketType = HandoffPacket.parse({
  version: "1.0",
  sessionId: "relay-7f3a",
  sourceAgent: "claude",
  targetAgent: "codex",
  trigger: "rate_limit",
  task: {
    goal: "Make the users.age migration safe to re-run without losing data.",
    acceptanceCriteria: [
      "Running the migration twice succeeds",
      "Existing user rows remain unchanged",
      "The focused test suite passes",
    ],
  },
  state: {
    status: "tests_failing",
    summary:
      "The migration shape is correct, but ALTER TABLE still runs unconditionally after a partial first attempt.",
  },
  evidence: {
    changedFiles: ["relay-mock/migrate.ts", "tests/migration.test.ts"],
    commands: [
      { command: "npm test -- migration", exitCode: 1 },
      { command: "npm run typecheck", exitCode: 0 },
    ],
    latestFailure: "SQLITE_ERROR: duplicate column name: age",
    diffSummary: [
      "Added a typed MigrationResult return value",
      "Introduced the migration entry point",
      "Focused test exposes the duplicate-column failure",
    ],
  },
  decisions: [
    {
      text: "Guard the schema change instead of swallowing SQLite errors",
      source: "agent",
    },
    {
      text: "Migrations are append-only and must preserve user data",
      source: "repository",
    },
  ],
  constraints: [
    "Do not drop or recreate the users table",
    "Keep the public applyMigration signature stable",
  ],
  nextActions: [
    "Read PRAGMA table_info(users) before altering the table",
    "Add an idempotency test that runs the migration twice",
    "Run npm test and npm run typecheck",
  ],
  verificationCommand: "npm test && npm run typecheck",
  metrics: {
    sourceTokens: 18420,
    packetTokens: 1218,
    reductionPercent: 93.4,
    confidence: 0.92,
  },
  pitfalls: [
    "Do not retry ALTER TABLE blindly—the first attempt may have succeeded before the provider crashed.",
    "Do not replace the table; that risks erasing existing user rows.",
  ],
  focusFiles: [
    {
      path: "relay-mock/migrate.ts",
      role: "Migration entry point",
      state: "Needs schema-existence guard",
    },
    {
      path: "tests/migration.test.ts",
      role: "Focused verification",
      state: "Needs second-run assertion",
    },
  ],
});

const eventInput = [
  {
    id: "relay-7f3a:1",
    sessionId: "relay-7f3a",
    type: "session.started",
    timestamp: "2026-06-21T05:41:12.000Z",
    agent: "claude",
    payload: { model: "claude-opus-4-8" },
  },
  {
    id: "relay-7f3a:2",
    sessionId: "relay-7f3a",
    type: "file.changed",
    timestamp: "2026-06-21T05:43:08.000Z",
    agent: "claude",
    payload: { path: "relay-mock/migrate.ts", additions: 18 },
  },
  {
    id: "relay-7f3a:3",
    sessionId: "relay-7f3a",
    type: "test.failed",
    timestamp: "2026-06-21T05:44:31.000Z",
    agent: "claude",
    payload: { command: "npm test -- migration", exitCode: 1 },
  },
  {
    id: "relay-7f3a:4",
    sessionId: "relay-7f3a",
    type: "limit.detected",
    timestamp: "2026-06-21T05:45:02.000Z",
    agent: "claude",
    payload: { reason: "rate_limit", detail: "API error 429" },
  },
  {
    id: "relay-7f3a:5",
    sessionId: "relay-7f3a",
    type: "workspace.frozen",
    timestamp: "2026-06-21T05:45:02.180Z",
    agent: "claude",
    payload: { changedFiles: 2, churn: 37 },
  },
  {
    id: "relay-7f3a:6",
    sessionId: "relay-7f3a",
    type: "handoff.distilling",
    timestamp: "2026-06-21T05:45:02.540Z",
    agent: "claude",
    payload: { compressProvider: "codex" },
  },
  {
    id: "relay-7f3a:7",
    sessionId: "relay-7f3a",
    type: "handoff.created",
    timestamp: "2026-06-21T05:45:04.000Z",
    agent: "claude",
    payload: { reductionPercent: 93.4, confidence: 0.92 },
  },
  {
    id: "relay-7f3a:8",
    sessionId: "relay-7f3a",
    type: "agent.switched",
    timestamp: "2026-06-21T05:45:05.000Z",
    agent: "codex",
    payload: { from: "claude", to: "codex", model: "gpt-5-codex" },
  },
] satisfies unknown[];

export const demoEvents: RelayEventType[] = eventInput.map((event) =>
  RelayEvent.parse(event)
);
