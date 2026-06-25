/**
 * Relay server — orchestrator (runtime coordinator)
 * -------------------------------------------------
 * The conductor of a session's runtime. It is the only component that starts or
 * stops agents, and it drives the session state machine while fanning every
 * `RelayEvent` to the event store and the broadcaster. It coordinates the
 * pieces but owns none of them — adapters, the evidence collector, the handoff
 * builder, the verifier, and the event store are all injected.
 *
 *   startClaude → claude_running
 *   sendInput   → forward to the live agent
 *   buildHandoff→ handoff_building → (collect evidence → createHandoff →
 *                 validate → save → emit) → handoff_ready
 *   startCodex  → codex_running   (resumes from the saved packet)
 *   verify      → verifying → completed | failed
 *
 * Built against the apps/server contracts (SessionManager, AgentAdapter, the
 * process runner) — it supersedes the root engine-prototype orchestrator.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  RelayEvent,
  type RelayEventType,
} from "../../../packages/shared/events";
import {
  HandoffPacket,
  type HandoffTrigger,
} from "../../../packages/shared/handoff";
import type { EvidenceBundle } from "../../../packages/shared/evidence";
import type { AgentId } from "../../../packages/shared/common";
import { distill } from "../../../compressor";
import { claudeAdapter as rootClaudeAdapter } from "../../../adapters/claude";
import { codexAdapter as rootCodexAdapter } from "../../../adapters/codex";
import type { SessionManager } from "./session-manager";
import type { AgentAdapter, RelayEventSink } from "./adapters/types";
import { collectEvidence, collectGitFacts } from "./evidence-collector";
import { runVerification, type VerificationResult } from "./verifier";

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** Metadata only the orchestrator knows, handed to the handoff builder. */
export interface HandoffMeta {
  sessionId: string;
  sourceAgent: AgentId;
  targetAgent: AgentId;
  trigger: HandoffTrigger;
  verificationCommand: string;
  sourceTokens: number;
  workspaceDir: string;
  /** Target-provider credential for this in-memory distillation call only. */
  apiKey?: string;
}

export type ProviderApiKeys = Partial<Record<AgentId, string>>;
export interface StartAgentOptions {
  model?: string;
  prompt?: string;
  /** Backward-compatible key for the provider being launched. */
  apiKey?: string;
  /** In-memory credentials used by both launch and automatic handoff. */
  apiKeys?: ProviderApiKeys;
  /** Per-provider models retained for an automatic continuation. */
  models?: Partial<Record<AgentId, string>>;
}

/** The handoff builder seam — Michael's `packages/context` provides the real one. */
export type CreateHandoff = (
  evidence: EvidenceBundle,
  meta: HandoffMeta
) => HandoffPacket | Promise<HandoffPacket>;

/**
 * The durable store the orchestrator depends on. Michael's
 * `apps/server/src/event-store.ts` (Redis) implements this; `InMemoryEventStore`
 * below is the fallback used for local dev and tests.
 */
export interface EventStore {
  appendEvent(sessionId: string, event: RelayEvent): void | Promise<void>;
  /** Ordered timeline; with `after` (a RelayEvent id), only events past it. */
  readEvents(
    sessionId: string,
    after?: string
  ): RelayEvent[] | Promise<RelayEvent[]>;
  saveHandoff(sessionId: string, packet: HandoffPacket): void | Promise<void>;
  loadHandoff(
    sessionId: string
  ): HandoffPacket | null | Promise<HandoffPacket | null>;
  /** Optional lifecycle hooks implemented by durable stores. */
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface OrchestratorDeps {
  sessions: SessionManager;
  /** Factory per provider — a fresh adapter instance per agent run. */
  adapters: Record<AgentId, () => AgentAdapter>;
  store: EventStore;
  createHandoff: CreateHandoff;
  /** Broadcaster sink — every event is forwarded here for live UI. */
  onEvent?: RelayEventSink;
  /** Verification runner (injectable for tests). Defaults to `runVerification`. */
  verify?: typeof runVerification;
  /** Proactive context-pressure trigger, as a ratio of tokens/window. */
  contextPressureThreshold?: number;
  /** Guard against automatic provider ping-pong. Defaults to one demo handoff. */
  maxAutomaticHandoffs?: number;
}

interface SessionRuntime {
  provider: AgentId;
  adapter: AgentAdapter | null;
  terminal: string;
  latestFailure: string | null;
  limitDetected: boolean;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private readonly runtime = new Map<string, SessionRuntime>();
  private readonly handoffs = new Map<string, Promise<HandoffPacket>>();
  private readonly automaticHandoffs = new Map<string, number>();
  private readonly providerKeys = new Map<string, ProviderApiKeys>();
  private readonly providerModels = new Map<
    string,
    Partial<Record<AgentId, string>>
  >();

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Start Claude on a freshly created session or from a saved handoff. */
  async startClaude(
    sessionId: string,
    opts: StartAgentOptions = {}
  ): Promise<void> {
    await this.startResumableAgent(sessionId, "claude", "claude_running", opts);
  }

  /** Forward input to the live agent's stdin. */
  sendInput(sessionId: string, data: string): void {
    const rt = this.runtime.get(sessionId);
    if (!rt?.adapter) throw new Error(`No live agent for session "${sessionId}".`);
    rt.adapter.sendInput(data);
  }

  /** Resize the live agent's terminal so an interactive TUI reflows. */
  resize(sessionId: string, cols: number, rows: number): void {
    this.runtime.get(sessionId)?.adapter?.resize?.(cols, rows);
  }

  /**
   * Deliver a chat message to the *active* agent — the single-chat illusion.
   *
   * If the live agent accepts stdin (interactive adapters / demo fakes) the
   * message is forwarded directly. Otherwise — the one-shot CLIs — a fresh run
   * of the current provider is started with the message as its prompt, resuming
   * from the saved handoff packet when one exists so prior context travels with
   * the turn. The active provider never changes here; handoffs are explicit.
   */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const rt = this.ensureRuntime(sessionId);
    if (
      rt.adapter?.status() === "running" &&
      rt.adapter.capabilities().supportsInput
    ) {
      rt.adapter.sendInput(text);
      return;
    }
    if (rt.adapter?.status() === "running") {
      throw new Error("The active agent is still working on the previous turn.");
    }

    const provider = rt.provider;
    const targetState =
      provider === "claude" ? "claude_running" : "codex_running";
    const packet = await this.deps.store.loadHandoff(sessionId);
    let manifestPath: string | undefined;
    if (packet) {
      manifestPath = path.join(
        os.tmpdir(),
        `relay-handoff-${sessionId}-${randomUUID()}.json`
      );
      fs.writeFileSync(manifestPath, JSON.stringify(packet, null, 2));
    }
    try {
      await this.startAgent(sessionId, provider, targetState, {
        model: this.providerModels.get(sessionId)?.[provider],
        prompt: text,
        apiKey: this.providerKey(sessionId, provider),
        manifestPath,
      });
    } finally {
      if (manifestPath) {
        try {
          fs.unlinkSync(manifestPath);
        } catch {
          /* already removed */
        }
      }
    }
  }

  /**
   * Build a handoff packet from current evidence and make the session ready for
   * the next agent. On any failure the session is moved to `failed` rather than
   * left in an inconsistent state.
   */
  async buildHandoff(
    sessionId: string,
    trigger: HandoffTrigger = "manual"
  ): Promise<HandoffPacket> {
    const current = this.handoffs.get(sessionId);
    if (current) return current;
    const handoff = this.runBuildHandoff(sessionId, trigger).finally(() =>
      this.handoffs.delete(sessionId)
    );
    this.handoffs.set(sessionId, handoff);
    return handoff;
  }

  private async runBuildHandoff(
    sessionId: string,
    trigger: HandoffTrigger
  ): Promise<HandoffPacket> {
    const session = this.deps.sessions.get(sessionId);
    const rt = this.ensureRuntime(sessionId);
    this.deps.sessions.transition(sessionId, "handoff_building");
    this.emit(sessionId, "handoff.started", { from: rt.provider, trigger });

    try {
      // Detach the current agent before snapshotting the workspace.
      await rt.adapter?.stop();

      const evidence = collectEvidence(session.workspaceDir, {
        sessionId,
        goal: session.goal,
        acceptanceCriteria: session.acceptanceCriteria,
        latestFailure: rt.latestFailure,
        relevantTerminalExcerpt: rt.terminal,
      });
      this.emit(sessionId, "workspace.frozen", {
        changedFiles: evidence.changedFiles.length,
        branch: evidence.branch,
      });

      const targetAgent: AgentId = rt.provider === "claude" ? "codex" : "claude";
      this.emit(sessionId, "agent.routed", {
        from: rt.provider,
        to: targetAgent,
      });
      const usage = rt.adapter?.usage() ?? {
        tokens: approxTokens(JSON.stringify(evidence)),
        window: 200_000,
      };
      this.emit(sessionId, "handoff.distilling", {
        sourceTokens: usage.tokens,
      });
      const packet = HandoffPacket.parse(
        await this.deps.createHandoff(evidence, {
          sessionId,
          sourceAgent: rt.provider,
          targetAgent,
          trigger,
          verificationCommand: session.verificationCommand,
          sourceTokens: usage.tokens,
          workspaceDir: session.workspaceDir,
          apiKey: this.providerKey(sessionId, targetAgent),
        })
      );

      await this.deps.store.saveHandoff(sessionId, packet);
      this.deps.sessions.update(sessionId, { targetAgent });
      this.emit(sessionId, "handoff.created", {
        goal: packet.task.goal,
        targetAgent: packet.targetAgent,
        metrics: packet.metrics,
        packet,
      });
      this.deps.sessions.transition(sessionId, "handoff_ready");
      return packet;
    } catch (err) {
      this.emit(sessionId, "handoff.failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.deps.sessions.transition(sessionId, "failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.clearProviderConfig(sessionId);
      throw err;
    }
  }

  /** Start Codex on a freshly created session or from a saved handoff. */
  async startCodex(
    sessionId: string,
    opts: StartAgentOptions = {}
  ): Promise<void> {
    await this.startResumableAgent(sessionId, "codex", "codex_running", opts);
  }

  private async startResumableAgent(
    sessionId: string,
    provider: AgentId,
    targetState: "claude_running" | "codex_running",
    opts: StartAgentOptions = {}
  ): Promise<void> {
    this.rememberProviderConfig(sessionId, provider, opts);
    const session = this.deps.sessions.get(sessionId);
    const packet = await this.deps.store.loadHandoff(sessionId);
    if (!packet && session.state !== "created") {
      throw new Error(`No handoff packet saved for session "${sessionId}".`);
    }
    let manifestPath: string | undefined;
    if (packet) {
      manifestPath = path.join(
        os.tmpdir(),
        `relay-handoff-${sessionId}-${randomUUID()}.json`
      );
      fs.writeFileSync(manifestPath, JSON.stringify(packet, null, 2));
    }
    try {
      await this.startAgent(sessionId, provider, targetState, {
        model: opts.model ?? this.providerModels.get(sessionId)?.[provider],
        prompt: opts.prompt,
        apiKey: this.providerKey(sessionId, provider),
        manifestPath,
      });
    } finally {
      if (manifestPath) {
        try {
          fs.unlinkSync(manifestPath);
        } catch {
          /* already removed */
        }
      }
    }
    if (packet) {
      this.emit(sessionId, "agent.switched", {
        from: packet.sourceAgent,
        to: provider,
      });
    }
  }

  /** Run the session's verification command and record the verdict. */
  async verify(sessionId: string): Promise<VerificationResult> {
    const session = this.deps.sessions.get(sessionId);
    const rt = this.ensureRuntime(sessionId);
    this.deps.sessions.transition(sessionId, "verifying");
    const verify = this.deps.verify ?? runVerification;
    const result = await verify(
      {
        sessionId,
        command: session.verificationCommand,
        cwd: session.workspaceDir,
        agent: rt.provider,
      },
      this.sink(sessionId)
    );
    this.deps.sessions.transition(
      sessionId,
      result.passed ? "completed" : "failed",
      result.passed ? undefined : { error: `verification failed (exit ${result.exitCode})` }
    );
    if (result.passed) {
      this.emit(sessionId, "session.completed", {
        verificationCommand: session.verificationCommand,
      });
    } else {
      this.emit(sessionId, "session.failed", {
        error: `verification failed (exit ${result.exitCode})`,
        verificationCommand: session.verificationCommand,
      });
    }
    this.clearProviderConfig(sessionId);
    return result;
  }

  /** Current git diff + changed files for the session's workspace. */
  getDiff(sessionId: string): {
    branch: string;
    diff: string;
    changedFiles: string[];
  } {
    const session = this.deps.sessions.get(sessionId);
    const facts = collectGitFacts(session.workspaceDir);
    return {
      branch: facts.branch,
      diff: facts.gitDiff,
      changedFiles: facts.changedFiles,
    };
  }

  /** The ordered event timeline for a session, optionally after a cursor. */
  async getEvents(sessionId: string, after?: string): Promise<RelayEvent[]> {
    return this.deps.store.readEvents(sessionId, after);
  }

  /** Stop every live adapter during server shutdown. Safe to call repeatedly. */
  async stopAll(): Promise<void> {
    const adapters = [...this.runtime.values()]
      .map((rt) => rt.adapter)
      .filter((adapter): adapter is AgentAdapter => adapter !== null);
    await Promise.allSettled(adapters.map((adapter) => adapter.stop()));
    this.providerKeys.clear();
    this.providerModels.clear();
  }

  // --- internals ----------------------------------------------------------

  private async startAgent(
    sessionId: string,
    provider: AgentId,
    targetState: "claude_running" | "codex_running",
    opts: { model?: string; prompt?: string; apiKey?: string; manifestPath?: string }
  ): Promise<void> {
    const session = this.deps.sessions.get(sessionId);
    const startingSession = session.state === "created";
    const factory = this.deps.adapters[provider];
    if (!factory) throw new Error(`No adapter registered for "${provider}".`);

    const adapter = factory();
    this.deps.sessions.transition(sessionId, targetState);
    const rt: SessionRuntime = {
      provider,
      adapter,
      terminal: "",
      latestFailure: null,
      limitDetected: false,
    };
    this.runtime.set(sessionId, rt);
    if (startingSession) {
      this.emit(sessionId, "session.started", { provider });
    }
    this.emit(sessionId, "agent.launching", {
      target: provider,
      resumed: Boolean(opts.manifestPath),
      supportsInput: adapter.capabilities().supportsInput,
    });

    try {
      await adapter.start(
        {
          sessionId,
          cwd: session.workspaceDir,
          model: opts.model,
          prompt: opts.prompt ?? session.goal,
          apiKey: opts.apiKey,
          manifestPath: opts.manifestPath,
        },
        this.sink(sessionId)
      );
    } catch (err) {
      this.deps.sessions.transition(sessionId, "failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.emit(sessionId, "session.failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.clearProviderConfig(sessionId);
      throw err;
    }
  }

  private ensureRuntime(sessionId: string): SessionRuntime {
    let rt = this.runtime.get(sessionId);
    if (!rt) {
      // A session whose agent was started out-of-band; default to claude.
      rt = {
        provider: "claude",
        adapter: null,
        terminal: "",
        latestFailure: null,
        limitDetected: false,
      };
      this.runtime.set(sessionId, rt);
    }
    return rt;
  }

  /** The wrapped sink: store → observe runtime evidence → broadcast. */
  private sink(sessionId: string): RelayEventSink {
    return (event) => {
      void this.deps.store.appendEvent(sessionId, event);
      this.observe(sessionId, event);
      this.deps.onEvent?.(event);
    };
  }

  private observe(sessionId: string, event: RelayEvent): void {
    const rt = this.runtime.get(sessionId);
    if (!rt) return;
    if (event.type === "terminal.output") {
      const chunk = String((event.payload as { chunk?: string }).chunk ?? "");
      rt.terminal = (rt.terminal + chunk).slice(-8000); // bounded tail
      if (/\b429\b|rate[ _-]?limit|quota|too many requests/i.test(chunk)) {
        rt.latestFailure = chunk.slice(-2000);
        this.detectLimit(sessionId, rt, "rate_limit", { detail: chunk.slice(0, 300) });
        return;
      }
      this.checkContextPressure(sessionId, rt);
    }
    const exitCode = (event.payload as { exitCode?: number | null }).exitCode;
    if (
      event.type === "test.failed" ||
      (event.type === "process.exited" && typeof exitCode === "number" && exitCode !== 0)
    ) {
      rt.latestFailure = rt.terminal.slice(-2000) || `exit ${exitCode}`;
      this.detectLimit(sessionId, rt, "crash", { exitCode });
    }
  }

  private checkContextPressure(sessionId: string, rt: SessionRuntime): void {
    if (!this.canAutoHandoff(sessionId)) return;
    if (!rt.adapter || rt.adapter.status() !== "running") return;
    const usage = rt.adapter.usage();
    const threshold = this.deps.contextPressureThreshold ?? 0.8;
    if (usage.window <= 0 || usage.tokens / usage.window < threshold) return;
    this.detectLimit(sessionId, rt, "context_full", {
      tokens: usage.tokens,
      window: usage.window,
      threshold,
    });
  }

  private detectLimit(
    sessionId: string,
    rt: SessionRuntime,
    trigger: Exclude<HandoffTrigger, "manual">,
    payload: Record<string, unknown>
  ): void {
    if (!this.canAutoHandoff(sessionId)) return;
    if (rt.limitDetected || this.handoffs.has(sessionId)) return;
    const count = this.automaticHandoffs.get(sessionId) ?? 0;
    if (count >= (this.deps.maxAutomaticHandoffs ?? 1)) return;
    this.automaticHandoffs.set(sessionId, count + 1);
    rt.limitDetected = true;
    this.emit(sessionId, "limit.detected", { reason: trigger, ...payload });
    void this.runAutomaticHandoff(sessionId, trigger);
  }

  private async runAutomaticHandoff(
    sessionId: string,
    trigger: Exclude<HandoffTrigger, "manual">
  ): Promise<void> {
    try {
      const packet = await this.buildHandoff(sessionId, trigger);
      await this.startResumableAgent(
        sessionId,
        packet.targetAgent,
        packet.targetAgent === "claude" ? "claude_running" : "codex_running"
      );
    } catch {
      // buildHandoff/startAgent already move the session to failed when needed.
    }
  }

  private canAutoHandoff(sessionId: string): boolean {
    const state = this.deps.sessions.get(sessionId).state;
    return state === "claude_running" || state === "codex_running";
  }

  private rememberProviderConfig(
    sessionId: string,
    provider: AgentId,
    opts: StartAgentOptions
  ): void {
    const current = this.providerKeys.get(sessionId) ?? {};
    const next: ProviderApiKeys = { ...current };
    for (const id of ["claude", "codex"] as const) {
      const key = opts.apiKeys?.[id]?.trim();
      if (key) next[id] = key;
    }
    const direct = opts.apiKey?.trim();
    if (direct) next[provider] = direct;
    if (Object.keys(next).length > 0) this.providerKeys.set(sessionId, next);

    const currentModels = this.providerModels.get(sessionId) ?? {};
    const nextModels = { ...currentModels };
    for (const id of ["claude", "codex"] as const) {
      const model = opts.models?.[id]?.trim();
      if (model) nextModels[id] = model;
    }
    const directModel = opts.model?.trim();
    if (directModel) nextModels[provider] = directModel;
    if (Object.keys(nextModels).length > 0) {
      this.providerModels.set(sessionId, nextModels);
    }
  }

  private providerKey(sessionId: string, provider: AgentId): string | undefined {
    return this.providerKeys.get(sessionId)?.[provider];
  }

  private clearProviderConfig(sessionId: string): void {
    this.providerKeys.delete(sessionId);
    this.providerModels.delete(sessionId);
  }

  private emit(
    sessionId: string,
    type: RelayEventType,
    payload: Record<string, unknown>
  ): void {
    this.sink(sessionId)(
      RelayEvent.parse({
        id: `evt-${randomUUID()}`,
        sessionId,
        type,
        timestamp: new Date().toISOString(),
        payload,
      })
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory fallbacks (replaced by Michael's event-store + context package)
// ---------------------------------------------------------------------------

/** In-memory `EventStore` for local dev/tests. Same interface as Redis's. */
export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, RelayEvent[]>();
  private readonly handoffs = new Map<string, HandoffPacket>();

  appendEvent(sessionId: string, event: RelayEvent): void {
    const list = this.events.get(sessionId) ?? [];
    list.push(event);
    this.events.set(sessionId, list);
  }
  readEvents(sessionId: string, after?: string): RelayEvent[] {
    const all = [...(this.events.get(sessionId) ?? [])];
    if (!after) return all;
    const idx = all.findIndex((e) => e.id === after);
    return idx === -1 ? all : all.slice(idx + 1);
  }
  saveHandoff(sessionId: string, packet: HandoffPacket): void {
    this.handoffs.set(sessionId, packet);
  }
  loadHandoff(sessionId: string): HandoffPacket | null {
    return this.handoffs.get(sessionId) ?? null;
  }
}

const approxTokens = (s: string): number => Math.ceil(s.length / 4);

/** Real handoff builder: runs the compressor/distiller model over evidence. */
export const compressorCreateHandoff: CreateHandoff = (evidence, meta) =>
  distill(
    evidence,
    {
      sessionId: meta.sessionId,
      sourceAgent: meta.sourceAgent,
      targetAgent: meta.targetAgent,
      trigger: meta.trigger,
      verificationCommand: meta.verificationCommand,
      sourceTokens: meta.sourceTokens,
    },
    {
      cwd: meta.workspaceDir,
      backend:
        meta.targetAgent === "codex"
          ? (prompt, opts) =>
              rootCodexAdapter.compress(prompt, {
                ...opts,
                env: providerEnv("codex", meta.apiKey),
              })
          : (prompt, opts) =>
              rootClaudeAdapter.compress(prompt, {
                ...opts,
                env: providerEnv("claude", meta.apiKey),
              }),
    }
  );

function providerEnv(
  provider: AgentId,
  apiKey?: string
): NodeJS.ProcessEnv | undefined {
  if (!apiKey) return undefined;
  return {
    ...process.env,
    [provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]: apiKey,
  };
}

/**
 * Deterministic placeholder handoff builder so the handoff route works before
 * Michael's `createFallbackHandoff` lands. Preserves the exact goal, changed
 * files, commands, latest failure, and verification command; generates a
 * concise next action by rule. Injected — swap for the real builder later.
 */
export const fallbackCreateHandoff: CreateHandoff = (evidence, meta) => {
  const status = evidence.latestFailure ? "tests_failing" : "in_progress";
  const summary = `${evidence.changedFiles.length} file(s) changed.${
    evidence.latestFailure ? " A failure is recorded." : ""
  }`;
  const nextActions = evidence.latestFailure
    ? ["Investigate the latest failure and make the failing check pass."]
    : ["Continue the task toward the stated goal."];
  const sourceTokens = approxTokens(JSON.stringify(evidence));

  const draft = {
    version: "1.0" as const,
    sessionId: meta.sessionId,
    sourceAgent: meta.sourceAgent,
    targetAgent: meta.targetAgent,
    trigger: meta.trigger,
    task: { goal: evidence.goal, acceptanceCriteria: evidence.acceptanceCriteria },
    state: { status, summary },
    evidence: {
      changedFiles: evidence.changedFiles,
      commands: evidence.commands.map((c) => ({
        command: c.command,
        exitCode: c.exitCode,
      })),
      latestFailure: evidence.latestFailure,
      diffSummary: evidence.changedFiles.map((f) => `changed: ${f}`),
    },
    decisions: [],
    constraints: [],
    nextActions,
    verificationCommand: meta.verificationCommand,
    metrics: { sourceTokens, packetTokens: 0, reductionPercent: 0, confidence: 0.3 },
    pitfalls: [],
    focusFiles: [],
  };
  const packetTokens = approxTokens(JSON.stringify(draft));
  draft.metrics.packetTokens = packetTokens;
  draft.metrics.reductionPercent =
    sourceTokens > 0
      ? Math.max(0, Math.round((1 - packetTokens / sourceTokens) * 1000) / 10)
      : 0;
  return HandoffPacket.parse(draft);
};
