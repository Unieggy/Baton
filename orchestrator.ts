/**
 * RelayIDE — Orchestrator
 * -----------------------
 * The conductor. It owns the lifecycle of "the work" as it moves between
 * providers, and it is the ONLY component allowed to start or stop a session.
 *
 * It is provider-neutral by construction: it holds a registry of
 * `ProviderAdapter`s and a `Router`, and it never names a concrete provider or
 * treats one as a "home base". The very first session is just another
 * `RouteTarget`; a "switch" is the same flow whether we're leaving Claude for
 * Codex, Codex for Gemini, or anything else.
 *
 * The switch state machine (one transactional flow per trigger):
 *
 *   freeze   → capture the workspace snapshot (git diff + skeletons)
 *   route    → reason + snapshot → where to land (which provider/model)
 *   compress → distil the situation into a small handoff manifest, run on a
 *              provider that is currently UP (never the one that just died)
 *   launch   → boot a fresh session of the target, seeded with the manifest
 *   resume   → retire the old session, adopt the new one as current
 *
 * Triggers feed in through a single door — `requestSwitch(reason)` — whether
 * they come from a live session's error stream (rate limit / crash), the
 * workspace/terminal monitors (context pressure), or a human clicking a button
 * (manual). Everything that observes the run subscribes to the orchestrator's
 * events, which double as the Relay timeline.
 */

import { EventEmitter } from "events";
import * as path from "path";
import { captureWorkspace, WorkspaceSnapshot } from "./extract";
import { runCompression, HandoffManifest } from "./compressor";
import {
  CompressBackend,
  LiveSession,
  ProviderAdapter,
  RouteTarget,
  Router,
  SwitchReason,
} from "./contracts";

// ---------------------------------------------------------------------------
// Default router — a simple ordered fleet with failover
// ---------------------------------------------------------------------------

/**
 * The Router is "owned by the routing team" per the contract, but the
 * orchestrator must be runnable on its own, so this is the sensible default:
 * an ordered fleet of targets. A manual switch with an explicit target is
 * honoured verbatim; every other reason fails over to the first fleet member
 * that isn't the current provider (and falls back to staying put if the fleet
 * has nowhere else to go).
 */
export class FleetRouter implements Router {
  constructor(private readonly fleet: RouteTarget[]) {
    if (fleet.length === 0) {
      throw new Error("FleetRouter needs at least one RouteTarget.");
    }
  }

  route(
    reason: SwitchReason,
    ctx: { current: RouteTarget; snapshot: WorkspaceSnapshot }
  ): RouteTarget {
    if (reason.kind === "manual" && reason.target) return reason.target;

    const next = this.fleet.find(
      (t) => t.provider !== ctx.current.provider
    );
    return next ?? ctx.current;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export type OrchestratorPhase =
  | "idle" // constructed, no session yet
  | "running" // a session is live
  | "switching" // a switch transaction is in flight
  | "stopped"; // torn down

export interface OrchestratorOptions {
  /** The workspace every provider operates inside (the source of truth). */
  workspaceDir: string;
  /** The provider fleet. Order matters: it doubles as the failover order. */
  adapters: ProviderAdapter[];
  /** Routing policy. Defaults to a FleetRouter over the adapters' providers. */
  router?: Router;
  /** Model used to perform compression. */
  compressorModel?: string;
  /** Where the handoff manifest is written / read between sessions. */
  handoffPath?: string;
}

export class Orchestrator extends EventEmitter {
  private readonly workspaceDir: string;
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly router: Router;
  private readonly compressorModel?: string;
  private readonly handoffPath: string;

  private phase: OrchestratorPhase = "idle";
  private current: LiveSession | null = null;
  private currentTarget: RouteTarget | null = null;
  private lastManifest: HandoffManifest | null = null;
  /** Held while a switch runs so re-entrant triggers join it instead of racing. */
  private inFlight: Promise<LiveSession> | null = null;

  constructor(opts: OrchestratorOptions) {
    super();
    if (opts.adapters.length === 0) {
      throw new Error("Orchestrator needs at least one ProviderAdapter.");
    }
    this.workspaceDir = path.resolve(opts.workspaceDir);
    this.adapters = new Map(opts.adapters.map((a) => [a.provider, a]));
    this.router =
      opts.router ??
      new FleetRouter(
        opts.adapters.map((a) => ({ provider: a.provider, model: "" }))
      );
    this.compressorModel = opts.compressorModel;
    this.handoffPath =
      opts.handoffPath ?? path.join(this.workspaceDir, ".relay_handoff.json");
  }

  // --- public surface -----------------------------------------------------

  /** Boot the first session. No manifest is seeded — this is a cold start. */
  async start(initial: RouteTarget): Promise<LiveSession> {
    if (this.phase !== "idle") {
      throw new Error(`Orchestrator already started (phase=${this.phase}).`);
    }
    const adapter = this.adapterFor(initial.provider);

    const session = await adapter.launch({
      model: initial.model,
      workspace: this.workspaceDir,
    });

    this.adopt(session, initial);
    this.phase = "running";
    this.emitEvent("session.started", { target: initial });
    return session;
  }

  /**
   * The single door for every trigger. Idempotent under concurrency: if a
   * switch is already running, the caller joins the in-flight transaction
   * rather than kicking off a second one.
   */
  requestSwitch(reason: SwitchReason): Promise<LiveSession> {
    if (this.phase === "stopped") {
      return Promise.reject(new Error("Orchestrator is stopped."));
    }
    if (this.phase === "idle" || !this.current || !this.currentTarget) {
      return Promise.reject(
        new Error("Cannot switch before start() establishes a session.")
      );
    }
    if (this.inFlight) {
      this.emitEvent("switch.coalesced", { reason });
      return this.inFlight;
    }

    this.phase = "switching";
    this.emitEvent("switch.requested", { reason });

    this.inFlight = this.runSwitch(reason)
      .then((session) => {
        this.phase = "running";
        return session;
      })
      .catch((err) => {
        // The old session is still the source of truth on failure — stay on it.
        this.phase = "running";
        this.emitEvent("error", { phase: "switch", error: errMessage(err) });
        throw err;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /** Current orchestrator state — feeds the control tower / health indicator. */
  getState(): {
    phase: OrchestratorPhase;
    current: RouteTarget | null;
    lastManifest: HandoffManifest | null;
  } {
    return {
      phase: this.phase,
      current: this.currentTarget,
      lastManifest: this.lastManifest,
    };
  }

  /** Tear everything down. Stops the live session and refuses further work. */
  stop(): void {
    if (this.phase === "stopped") return;
    try {
      this.current?.stop();
    } catch {
      /* a provider that's already dead is fine to "stop" */
    }
    this.current = null;
    this.phase = "stopped";
    this.emitEvent("stopped", {});
  }

  // --- the switch transaction --------------------------------------------

  private async runSwitch(reason: SwitchReason): Promise<LiveSession> {
    const from = this.currentTarget!;

    // 1. FREEZE — re-derive the workspace from git, the source of truth.
    const snapshot = captureWorkspace(this.workspaceDir);
    this.emitEvent("frozen", {
      changedFiles: snapshot.changedFiles,
      churn: snapshot.stats.additions + snapshot.stats.deletions,
    });

    // 2. ROUTE — decide where to land before compressing, so the manifest can
    //    name the real destination model.
    const to = this.router.route(reason, { current: from, snapshot });
    this.adapterFor(to.provider); // validate the target is registered up front
    this.emitEvent("routed", { from, to, reason });

    // 3. COMPRESS — on a provider that is currently UP. The one that just died
    //    must not be asked to summarise its own demise.
    const { provider: compressProvider, backend } = this.pickCompressBackend(
      reason,
      from,
      to
    );
    this.emitEvent("compressing", {
      provider: compressProvider,
      targetModel: to.model,
    });

    let manifest: HandoffManifest;
    try {
      manifest = await runCompression({
        workspaceDir: this.workspaceDir,
        backend,
        compressorModel: this.compressorModel,
        targetModel: to.model,
        handoffPath: this.handoffPath,
      });
    } catch (err) {
      this.emitEvent("error", { phase: "compress", error: errMessage(err) });
      throw err;
    }
    this.lastManifest = manifest;
    this.emitEvent("compressed", {
      handoffPath: this.handoffPath,
      goal: manifest.task?.goal,
    });

    // 4. LAUNCH — boot the fresh target seeded with the manifest.
    this.emitEvent("launching", { target: to });
    const next = await this.adapterFor(to.provider).launch({
      model: to.model,
      workspace: this.workspaceDir,
      manifestPath: this.handoffPath,
    });

    // 5. RESUME — only now retire the old session and adopt the new one. If
    //    launch had thrown above, we'd never have touched the still-live old
    //    session.
    try {
      this.current?.stop();
    } catch {
      /* old session already gone */
    }
    this.adopt(next, to);
    this.emitEvent("switched", { from, to });
    return next;
  }

  // --- helpers ------------------------------------------------------------

  /**
   * Choose which provider runs the compression. The guiding rule: never the
   * one that just failed. For failure reasons we route AWAY from the current
   * provider, so the destination is by definition healthy — compress there.
   * For benign reasons (context_full, manual, cost) the current provider is
   * fine, but the destination works equally well and keeps the logic uniform.
   */
  private pickCompressBackend(
    reason: SwitchReason,
    from: RouteTarget,
    to: RouteTarget
  ): { provider: string; backend: CompressBackend } {
    const downProvider = isFailure(reason) ? from.provider : undefined;

    // Preference: the destination (known-up), then any adapter that isn't the
    // downed one, then — last resort — whatever we have.
    const candidates = [
      to.provider,
      ...Array.from(this.adapters.keys()),
    ];
    for (const provider of candidates) {
      if (provider === downProvider) continue;
      const adapter = this.adapters.get(provider);
      if (adapter) return { provider, backend: adapter.compress };
    }

    // Everything is "down" by our heuristic — fall back to the destination's
    // backend anyway; a deterministic fallback inside the compressor is the
    // real safety net.
    const fallback = this.adapterFor(to.provider);
    return { provider: fallback.provider, backend: fallback.compress };
  }

  private adapterFor(provider: string): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(
        `No adapter registered for provider "${provider}". ` +
          `Known: ${Array.from(this.adapters.keys()).join(", ") || "(none)"}.`
      );
    }
    return adapter;
  }

  /** Adopt a session as current and wire its error stream into the trigger door. */
  private adopt(session: LiveSession, target: RouteTarget): void {
    this.current = session;
    this.currentTarget = target;
    session.onError((err) => {
      // A live session failing is itself a switch trigger. Classify and route.
      this.requestSwitch(classifyError(err)).catch(() => {
        /* the switch's own error event already reported this */
      });
    });
  }

  private emitEvent(type: string, payload: Record<string, unknown>): void {
    this.emit("event", {
      type,
      provider: this.currentTarget?.provider,
      timestamp: new Date().toISOString(),
      payload,
    });
  }
}

// Strongly-typed event channel (declaration merge over EventEmitter). Every
// orchestrator emission is a single normalized `event` — the shape the Relay
// timeline / Redis stream consumes.
export interface OrchestratorEvent {
  type: string;
  provider?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
export interface Orchestrator {
  on(event: "event", listener: (e: OrchestratorEvent) => void): this;
  emit(event: "event", e: OrchestratorEvent): boolean;
}

// ---------------------------------------------------------------------------
// Trigger classification — raw failures → a structured SwitchReason
// ---------------------------------------------------------------------------

/** Does this reason imply the CURRENT provider is unusable right now? */
function isFailure(reason: SwitchReason): boolean {
  return (
    reason.kind === "rate_limit" ||
    reason.kind === "outage" ||
    reason.kind === "crash"
  );
}

/** Map an opaque session error into the structured reason the router expects. */
export function classifyError(err: unknown): SwitchReason {
  const msg = errMessage(err).toLowerCase();
  if (/rate.?limit|\b429\b|quota|too many requests/.test(msg)) {
    return { kind: "rate_limit" };
  }
  if (/context|token limit|maximum context|context length/.test(msg)) {
    return { kind: "context_full" };
  }
  if (/\b5\d\d\b|unavailable|timeout|econn|enotfound|network|outage/.test(msg)) {
    return { kind: "outage" };
  }
  return { kind: "crash", detail: errMessage(err) };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Demo harness — `npx tsx orchestrator.ts`
// ---------------------------------------------------------------------------
//
// Real adapters' `launch` is the injection team's step (and `compress` shells
// out to a live CLI), so this harness wires FAKE adapters to exercise the
// orchestrator end-to-end on its own: a Claude session "rate-limits", and the
// orchestrator freezes, routes to Codex, compresses, and resumes — printing the
// timeline it would feed the UI.

if (require.main === module) {
  const makeFakeAdapter = (provider: string): ProviderAdapter => ({
    provider,
    compress: async () =>
      JSON.stringify({
        target_model: `${provider}-model`,
        task: {
          goal: "Finish the users.age migration safely.",
          status: "blocked",
          progress: ["Wrote ALTER TABLE in migrate.ts"],
          remaining: ["Guard against partial application"],
          next_action: "Check the schema before re-running.",
        },
        focus_files: [],
        decisions: [],
        constraints: ["migrations are append-only"],
        open_questions: [],
        cognitive_negative_memory:
          "Do NOT re-run the migration blindly — the age column may be half-applied.",
      }),
    launch: async (opts) => {
      let errCb: (err: unknown) => void = () => {};
      const session: LiveSession = {
        provider,
        model: opts.model,
        usage: () => ({ tokens: 1200, window: 200000 }),
        onError: (cb) => {
          errCb = cb;
        },
        readTranscript: () => ({ ask: "fix the migration", tail: [] }),
        stop: () => {},
      };
      // For the demo, make the Claude session "rate-limit" shortly after boot.
      if (provider === "claude") {
        setTimeout(() => errCb(new Error("API error 429: rate limit exceeded")), 50);
      }
      return session;
    },
  });

  const orchestrator = new Orchestrator({
    workspaceDir: process.argv[2] || process.cwd(),
    adapters: [makeFakeAdapter("claude"), makeFakeAdapter("codex")],
    router: new FleetRouter([
      { provider: "claude", model: "claude-opus-4-8" },
      { provider: "codex", model: "gpt-5-codex" },
    ]),
  });

  orchestrator.on("event", (e) => {
    console.log(
      `[relay] ${e.type.padEnd(18)} ${JSON.stringify(e.payload)}`
    );
  });

  (async () => {
    console.log("[relay] starting on claude…");
    await orchestrator.start({ provider: "claude", model: "claude-opus-4-8" });
    // The fake claude session rate-limits on its own; give the switch time to
    // complete, then report where we landed.
    await new Promise((r) => setTimeout(r, 500));
    console.log("[relay] final state:", orchestrator.getState().current);
    orchestrator.stop();
  })().catch((err) => {
    console.error("[relay] demo failed:", err);
    process.exit(1);
  });
}
