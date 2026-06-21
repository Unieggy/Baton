/**
 * RelayIDE — Workspace Monitor (live, push-based)
 * -----------------------------------------------
 * Watches a workspace directory and maintains a continuously-updated
 * WorkspaceSnapshot (git diff + AST skeletons + churn stats). It is the PUSH
 * counterpart to the compressor's PULL: the compressor re-derives state once at
 * freeze time; the monitor keeps a live copy so the React UI can render "what's
 * changing right now" without polling, and so the orchestrator gets a churn
 * signal to help decide when to freeze.
 *
 * It shares the exact extraction logic with the compressor via `extract.ts`, so
 * the two can never disagree about what the workspace looks like.
 *
 * Design notes:
 *  - Stateless extraction, thin stateful shell: the only state held is the
 *    latest snapshot + a revision counter. Git remains the source of truth.
 *  - Debounced: a single file save fires several fs events; we coalesce them.
 *  - Change-gated: we only emit `update` when the *diff* actually changes, so
 *    incidental fs noise (atime bumps, editor temp files) stays silent.
 *  - fs.watch({recursive:true}) works on macOS and Windows. On Linux it is not
 *    supported — swap in `chokidar` there (drop-in: same event shape).
 */

import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { captureWorkspace, WorkspaceSnapshot } from "./extract";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonitorOptions {
  /** Coalesce window for fs events, in ms. Default 250. */
  debounceMs?: number;
  /**
   * If set, the monitor emits a `pressure` event the first time churn
   * (additions + deletions) crosses this value, and re-arms once churn drops
   * back below it. This is a workspace-churn signal — NOT the freeze trigger
   * itself (that comes from the terminal monitor watching for 429s / context
   * length), but a useful input to it.
   */
  churnThreshold?: number;
  /** Extra path prefixes (repo-relative) to ignore, beyond the defaults. */
  ignore?: string[];
}

/** Payload emitted on every meaningful change. */
export interface MonitorUpdate {
  revision: number; // increments on each emitted update
  snapshot: WorkspaceSnapshot; // the fresh capture
  churn: number; // additions + deletions, the pressure metric
}

// Always-ignored path fragments — watching these would fire constantly.
const DEFAULT_IGNORES = [".git/", "node_modules/", "dist/", ".relay_handoff.json"];

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

export class WorkspaceMonitor extends EventEmitter {
  private readonly dir: string;
  private readonly debounceMs: number;
  private readonly churnThreshold: number | null;
  private readonly ignores: string[];

  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  private snapshot: WorkspaceSnapshot | null = null;
  private lastSignature = ""; // gitDiff of the last emitted snapshot
  private revision = 0;
  private overThreshold = false; // de-dupes the `pressure` event

  constructor(dir: string, opts: MonitorOptions = {}) {
    super();
    this.dir = path.resolve(dir);
    this.debounceMs = opts.debounceMs ?? 250;
    this.churnThreshold = opts.churnThreshold ?? null;
    this.ignores = [...DEFAULT_IGNORES, ...(opts.ignore ?? [])];
  }

  /** Begin watching. Captures an initial baseline and emits it immediately. */
  start(): void {
    if (this.watcher) return; // already running

    // Baseline capture so subscribers have state before the first edit.
    this.refresh(true);

    try {
      this.watcher = fs.watch(
        this.dir,
        { recursive: true },
        (_event, filename) => {
          if (filename && this.isIgnored(filename.toString())) return;
          this.scheduleRefresh();
        }
      );
    } catch (err: any) {
      // Most likely: recursive watch unsupported (Linux).
      this.emit(
        "error",
        new Error(
          `Failed to start recursive watch on ${this.dir}: ${err.message}. ` +
            `On Linux, install chokidar and swap it in for fs.watch.`
        )
      );
    }
  }

  /** Stop watching and release resources. */
  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }

  /** The most recent snapshot (null until `start()` has captured one). */
  getSnapshot(): WorkspaceSnapshot | null {
    return this.snapshot;
  }

  // --- internals ----------------------------------------------------------

  private isIgnored(filename: string): boolean {
    const norm = filename.split(path.sep).join("/");
    return this.ignores.some(
      (frag) => norm === frag || norm.startsWith(frag) || norm.includes("/" + frag)
    );
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.refresh(false), this.debounceMs);
  }

  /**
   * Re-capture the workspace. Emits `update` only when the diff actually
   * changed (or on the forced baseline). Checks the churn threshold.
   */
  private refresh(force: boolean): void {
    let snapshot: WorkspaceSnapshot;
    try {
      snapshot = captureWorkspace(this.dir);
    } catch (err) {
      this.emit("error", err);
      return;
    }

    const signature = snapshot.gitDiff;
    if (!force && signature === this.lastSignature) return; // nothing material changed

    this.snapshot = snapshot;
    this.lastSignature = signature;
    this.revision++;

    const churn = snapshot.stats.additions + snapshot.stats.deletions;
    const update: MonitorUpdate = { revision: this.revision, snapshot, churn };
    this.emit("update", update);

    // Edge-triggered pressure signal.
    if (this.churnThreshold !== null) {
      if (!this.overThreshold && churn >= this.churnThreshold) {
        this.overThreshold = true;
        this.emit("pressure", update);
      } else if (this.overThreshold && churn < this.churnThreshold) {
        this.overThreshold = false; // re-arm
      }
    }
  }
}

// Strongly-typed event signatures (declaration merging over EventEmitter).
export interface WorkspaceMonitor {
  on(event: "update", listener: (u: MonitorUpdate) => void): this;
  on(event: "pressure", listener: (u: MonitorUpdate) => void): this;
  on(event: "error", listener: (err: unknown) => void): this;
  emit(event: "update", u: MonitorUpdate): boolean;
  emit(event: "pressure", u: MonitorUpdate): boolean;
  emit(event: "error", err: unknown): boolean;
}

// ---------------------------------------------------------------------------
// Demo harness — `npx tsx monitor.ts ./relay-mock`
// ---------------------------------------------------------------------------

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || process.cwd());
  const threshold = process.env.RELAY_CHURN_THRESHOLD
    ? Number(process.env.RELAY_CHURN_THRESHOLD)
    : undefined;

  const monitor = new WorkspaceMonitor(dir, { churnThreshold: threshold });

  monitor.on("update", ({ revision, snapshot, churn }) => {
    const { filesChanged, additions, deletions, diffBytes } = snapshot.stats;
    const files = snapshot.changedFiles.join(", ") || "(none)";
    console.log(
      `[monitor] rev ${revision} @ ${snapshot.capturedAt} | ` +
        `${filesChanged} file(s) +${additions}/-${deletions} | ` +
        `${diffBytes}b diff | churn ${churn} | ${files}`
    );
  });

  monitor.on("pressure", ({ churn }) => {
    console.log(`[monitor] ⚠️  churn ${churn} crossed threshold — consider freezing/compressing`);
  });

  monitor.on("error", (err) => {
    console.error("[monitor] error:", err instanceof Error ? err.message : err);
  });

  console.log(`[monitor] watching ${dir} … (edit files to see updates; Ctrl-C to stop)`);
  monitor.start();

  process.on("SIGINT", () => {
    console.log("\n[monitor] stopping.");
    monitor.stop();
    process.exit(0);
  });
}
