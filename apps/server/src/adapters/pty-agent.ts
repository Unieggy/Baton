/**
 * Relay server — PTY-backed interactive agent adapter (base)
 * ----------------------------------------------------------
 * The interactive sibling of `process-agent.ts`. It runs a real coding-agent TUI
 * (Claude, Codex) inside a pseudo-terminal via `pty-runner.ts`, so the user sees
 * and drives the genuine program — including its approval prompts — through
 * xterm.js in the UI. A concrete adapter only declares its identity, models, and
 * how to turn `AgentStartOptions` into an argv (`plan`); this base owns the
 * lifecycle:
 *
 *   start      → build the launch plan, spawn the PTY, track status.
 *   sendInput  → forward keystrokes to the PTY.
 *   resize     → reflow the TUI.
 *   stop       → terminate and wait for exit. Idempotent.
 *
 * Because the agent session is long-lived, `usage()` accumulates across the whole
 * conversation — so the orchestrator's context-pressure trigger is meaningful.
 */

import { startPty, type RelayPtyHandle } from "../pty-runner";
import type { AgentId } from "../../../../packages/shared/common";
import type { RelayEvent } from "../../../../packages/shared/events";
import { buildResumePrompt } from "./process-agent";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentStartOptions,
  AgentStatus,
  AgentUsage,
  RelayEventSink,
} from "./types";
import * as fs from "node:fs";

/** How a concrete interactive adapter wants the TUI launched. */
export interface PtyLaunchPlan {
  command: string;
  args: string[];
  /** Exact prompt text used for token estimation. */
  promptForUsage?: string;
}

export interface PtyAgentConfig {
  /** Override the executable — tests point this at a fixture binary. */
  executable?: string;
  /** Extra env merged over `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the advertised model list. */
  models?: string[];
}

export abstract class PtyAgentAdapter implements AgentAdapter {
  protected handle: RelayPtyHandle | null = null;
  protected state: AgentStatus = "idle";
  protected sessionId = "";
  protected outputChars = 0;
  protected promptChars = 0;
  protected observedTokens: number | null = null;

  abstract readonly agent: AgentId;
  protected abstract readonly defaultExecutable: string;

  constructor(protected readonly config: PtyAgentConfig = {}) {}

  abstract capabilities(): AgentCapabilities;

  /** Turn start options into an argv for the interactive TUI. */
  protected abstract plan(opts: AgentStartOptions): PtyLaunchPlan;

  protected get executable(): string {
    return this.config.executable ?? this.defaultExecutable;
  }

  protected spawnEnv(opts: AgentStartOptions): NodeJS.ProcessEnv {
    const keyVar =
      this.agent === "claude"
        ? "ANTHROPIC_API_KEY"
        : this.agent === "codex"
          ? "OPENAI_API_KEY"
          : null;
    const overrides: NodeJS.ProcessEnv = { ...this.config.env };
    if (opts.apiKey && keyVar) overrides[keyVar] = opts.apiKey;
    return { ...process.env, ...overrides };
  }

  status(): AgentStatus {
    return this.state;
  }

  usage(): AgentUsage {
    const tokens =
      this.observedTokens ??
      Math.ceil((this.promptChars + this.outputChars) / 4);
    return { tokens, window: this.capabilities().contextWindow ?? 200_000 };
  }

  async start(opts: AgentStartOptions, onEvent: RelayEventSink): Promise<void> {
    if (this.state === "starting" || this.state === "running") {
      throw new Error(`${this.agent} adapter is already started.`);
    }
    this.sessionId = opts.sessionId;
    this.state = "starting";

    let plan: PtyLaunchPlan;
    try {
      plan = this.plan(opts); // may read the manifest — throws before spawning
    } catch (err) {
      this.state = "failed";
      throw err;
    }
    this.promptChars = (plan.promptForUsage ?? opts.prompt ?? "").length;
    this.outputChars = 0;
    this.observedTokens = null;

    const sink: RelayEventSink = (event) => {
      this.observeEvent(event);
      onEvent(event);
    };

    this.handle = startPty(
      {
        sessionId: opts.sessionId,
        command: plan.command,
        args: plan.args,
        cwd: opts.cwd,
        agent: this.agent,
        env: this.spawnEnv(opts),
      },
      sink
    );
    this.state = "running";

    void this.handle.done
      .then((res) => {
        this.state = res.exitCode === 0 || res.signal !== null ? "exited" : "failed";
      })
      .catch(() => {
        this.state = "failed";
      });
  }

  sendInput(data: string): void {
    if (this.state !== "running" || !this.handle) {
      throw new Error(`Cannot sendInput while status is "${this.state}".`);
    }
    this.handle.write(data);
  }

  resize(cols: number, rows: number): void {
    this.handle?.resize(cols, rows);
  }

  async stop(): Promise<void> {
    if (!this.handle) {
      if (this.state === "idle") this.state = "exited";
      return;
    }
    if (this.state === "exited" || this.state === "failed") return;
    this.handle.terminate("SIGTERM");
    await this.handle.done.catch(() => undefined);
  }

  /** Read a handoff manifest from disk; throws if unreadable. */
  protected readManifest(manifestPath: string): string {
    return fs.readFileSync(manifestPath, "utf8");
  }

  /**
   * The agent's opening prompt. With a `manifestPath` the handoff packet is
   * framed as a resume instruction (reusing `buildResumePrompt`); otherwise the
   * raw prompt is used.
   */
  protected composePrompt(opts: AgentStartOptions): string {
    const base = opts.prompt ?? "";
    if (!opts.manifestPath) return base;
    return buildResumePrompt(this.readManifest(opts.manifestPath), base);
  }

  protected observeEvent(event: RelayEvent): void {
    if (event.type !== "terminal.output") return;
    const chunk = String((event.payload as { chunk?: unknown }).chunk ?? "");
    this.outputChars += chunk.length;
  }
}
