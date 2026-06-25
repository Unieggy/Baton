import { useEffect, useRef, useState, type ReactNode } from "react";
import { demoPacket } from "./demo";
import { useSessionTerminal } from "./useSessionTerminal";
import { deriveBench } from "./bench";
import {
  activeAgent,
  contextUsage,
  currentActivity,
  derivePhase,
  latestHandoffPacket,
  migrationState,
  rateState,
  statusLabel,
  type Phase,
} from "./live";
import {
  agentLabel,
  createSession as createRelaySession,
  modelFor,
  otherAgent,
  switchAgent as switchRelayAgent,
  type AgentId,
  type RelayApi,
} from "./controlFlow";

type IconName = "arrow" | "check" | "cross" | "spark" | "relay";

const icons: Record<IconName, ReactNode> = {
  arrow: <path d="M5 12h13m-5-6 6 6-6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  cross: <path d="M6 6l12 12M18 6 6 18" />,
  spark: <path d="m12 3 1.2 5L18 9l-4.8 1L12 15l-1.2-5L6 9l4.8-1z" />,
  relay: (
    <>
      <path d="M4 8h11l-3-3m3 3-3 3" />
      <path d="M20 16H9l3 3m-3-3 3-3" />
    </>
  ),
};

function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {icons[name]}
    </svg>
  );
}

function BatonMark({ size = 16 }: { size?: number }) {
  return (
    <span className="baton-mark" style={{ width: size, height: size }} aria-hidden="true">
      <i />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Ambient telemetry — monochrome meters, always visible while live
// ---------------------------------------------------------------------------

function Telemetry({
  phase,
  tokens,
  window,
  pct,
  rate,
  migration,
  verifyCommand,
  onVerify,
  verifyDisabled,
  bench,
}: {
  phase: Phase;
  tokens: number;
  window: number;
  pct: number;
  rate: "ok" | "limited";
  migration: "pass" | "fail" | "pending";
  verifyCommand: string;
  onVerify: () => void;
  verifyDisabled: boolean;
  bench: ReturnType<typeof deriveBench>;
}) {
  const k = (n: number): string =>
    n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`;
  const meterTone = pct >= 0.85 ? "hot" : pct >= 0.6 ? "warm" : "";

  return (
    <div className="telemetry">
      <div className="tel-row">
        <span className="tel-key">CONTEXT</span>
        <span className={`meter ${meterTone}`}>
          <span className="meter-fill" style={{ width: `${Math.round(pct * 100)}%` }} />
        </span>
        <span className="tel-val">
          {Math.round(pct * 100)}% · {k(tokens)}/{k(window)}
        </span>
      </div>

      <div className="tel-row split">
        <span className="tel-key">RATE</span>
        <span className={`tel-state ${rate}`}>{rate === "limited" ? "LIMITED" : "OK"}</span>
        <span className="tel-key">CHAIN</span>
        <span className={`chain ${phase}`}>
          <i className="dot done" />
          <i className={`bar ${phase !== "working" ? "on" : ""}`} />
          <i className={`dot ${phase !== "working" ? "on" : ""}`} />
          <i className={`bar ${phase === "resumed" ? "on" : ""}`} />
          <i className={`dot ${phase === "resumed" ? "on" : ""}`} />
        </span>
      </div>

      <div className="tel-row split">
        <span className="tel-key">VERIFY</span>
        <code className="tel-cmd" title={verifyCommand}>{verifyCommand}</code>
        <span className={`tel-state ${migration}`}>{migration.toUpperCase()}</span>
        <button className="tel-run" onClick={onVerify} disabled={verifyDisabled}>
          run
        </button>
      </div>

      <details className="bench">
        <summary>BatonBench</summary>
        <table className="bench-table">
          <thead>
            <tr>
              <th></th>
              <th>No Baton</th>
              <th>Baton</th>
            </tr>
          </thead>
          <tbody>
            {bench.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td className={row.without == null ? "nm" : ""}>{row.without ?? "—"}</td>
                <td className={row.withRelay == null ? "nm" : "val"}>
                  {row.withRelay ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// URL / API plumbing
// ---------------------------------------------------------------------------

function liveConfig(): {
  sessionId: string | null;
  base: string;
  api: string;
  railOnly: boolean;
} {
  if (typeof window === "undefined") {
    return {
      sessionId: null,
      base: "ws://127.0.0.1:4000",
      api: "http://127.0.0.1:4000",
      railOnly: false,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const base = params.get("ws") ?? "ws://127.0.0.1:4000";
  return {
    sessionId: params.get("live"),
    base,
    api: params.get("api") ?? base.replace(/^ws/i, "http"),
    railOnly: params.get("rail") === "1",
  };
}

async function requestJson<T>(
  apiBase: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      data?.error?.message ?? data?.message ?? `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data as T;
}

function updateLiveUrl(sessionId: string, base: string, api: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("live", sessionId);
  url.searchParams.set("ws", base);
  url.searchParams.set("api", api);
  window.history.replaceState(null, "", url);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const config = liveConfig();
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(config.sessionId);
  const [wsBase] = useState(config.base);
  const [apiBase, setApiBase] = useState(config.api);
  const [task, setTask] = useState(demoPacket.task.goal);
  const [verificationCommand, setVerificationCommand] = useState("npm test");
  const [workspaceDir, setWorkspaceDir] = useState("demo-repo");
  const [initialAgent, setInitialAgent] = useState<AgentId>("claude");
  const [claudeModel, setClaudeModel] = useState("claude-sonnet-4-6");
  // Blank → let Codex use its account default. A forced "gpt-5-codex" is rejected
  // by ChatGPT-account Codex ("model is not supported when using a ChatGPT account").
  const [codexModel, setCodexModel] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [controlMessage, setControlMessage] = useState("");
  const isLive = currentSessionId !== null;
  const termHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!currentSessionId) return;
    let cancelled = false;
    void requestJson<{
      goal: string;
      verificationCommand: string;
      workspaceDir: string;
      sourceAgent: AgentId;
    }>(apiBase, `/api/sessions/${currentSessionId}`)
      .then((session) => {
        if (cancelled) return;
        setTask(session.goal);
        setVerificationCommand(session.verificationCommand);
        setWorkspaceDir(session.workspaceDir);
        setInitialAgent(session.sourceAgent);
      })
      .catch(() => {
        /* event stream still provides diagnostics if hydration is unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, apiBase]);

  const { events, status } = useSessionTerminal(currentSessionId, termHost, wsBase, apiBase);

  async function runControl(action: string, work: () => Promise<void>): Promise<void> {
    setPendingAction(action);
    setControlMessage("");
    try {
      await work();
    } catch (err) {
      setControlMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingAction(null);
    }
  }

  const api: RelayApi = {
    requestJson: (path, init) => requestJson(apiBase, path, init),
  };

  async function createSessionRequest(): Promise<string> {
    const sessionId = await createRelaySession(api, {
      goal: task,
      verificationCommand,
      workspaceDir,
      initialAgent,
    });
    setCurrentSessionId(sessionId);
    updateLiveUrl(sessionId, wsBase, apiBase);
    return sessionId;
  }

  async function ensureLiveSession(): Promise<string> {
    return currentSessionId ?? createSessionRequest();
  }

  async function sessionAction(
    action: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<void> {
    await runControl(action, async () => {
      const sessionId = await ensureLiveSession();
      await requestJson(apiBase, `/api/sessions/${sessionId}${path}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : "{}",
      });
    });
  }

  const apiKeys = { claude: anthropicKey.trim(), codex: openaiKey.trim() };
  function keyFor(agent: AgentId): string | undefined {
    const k = agent === "claude" ? apiKeys.claude : apiKeys.codex;
    return k ? k : undefined;
  }

  async function startNewSession(): Promise<void> {
    await runControl(`start ${initialAgent}`, async () => {
      const sessionId = await createSessionRequest();
      await requestJson(apiBase, `/api/sessions/${sessionId}/${initialAgent}/start`, {
        method: "POST",
        body: JSON.stringify({
          model: modelFor(initialAgent, { claude: claudeModel, codex: codexModel }),
          prompt: task,
          apiKey: keyFor(initialAgent),
          apiKeys,
          models: { claude: claudeModel, codex: codexModel },
        }),
      });
    });
  }

  async function switchAgent(target: AgentId): Promise<void> {
    await runControl(`switch to ${target}`, async () => {
      const sessionId = await ensureLiveSession();
      await switchRelayAgent(api, {
        sessionId,
        initialAgent,
        target,
        models: { claude: claudeModel, codex: codexModel },
        prompt: task,
        apiKeys,
      });
    });
  }

  // ---- live derivations -------------------------------------------------
  const phase: Phase = isLive ? derivePhase(events) : "working";
  const active = isLive && events.length ? activeAgent(events) : initialAgent;
  const packet = isLive ? latestHandoffPacket(events) : null;
  const bench = deriveBench(isLive ? events : [], packet);
  const sessionComplete = isLive && events.some((e) => e.type === "session.completed");
  const sessionFailed =
    isLive && events.some((e) => e.type === "session.failed" || e.type === "handoff.failed");
  const sessionTerminal = sessionComplete || sessionFailed;
  const tag = statusLabel(events, phase, isLive);
  const usage = contextUsage(events, active);
  const rate = isLive ? rateState(events) : "ok";
  const migration = isLive ? migrationState(events) : "pending";
  const activity = isLive ? currentActivity(events, task) : task;

  const switchTarget = otherAgent(active);
  const busy = pendingAction !== null;
  const actionsLocked = busy || sessionTerminal || phase === "switching";

  const hasNativePicker =
    typeof window !== "undefined" && Boolean(window.relay?.pickWorkspace);
  async function browseWorkspace(): Promise<void> {
    const picked = await window.relay?.pickWorkspace?.();
    if (typeof picked === "string") setWorkspaceDir(picked);
  }

  return (
    <main className={`app ${config.railOnly ? "rail-only" : ""}`}>
      <aside className="sidebar" aria-label="Baton companion">
        <header className="bar">
          <BatonMark />
          <strong>Baton</strong>
          {isLive && (
            <span className="session" title={currentSessionId ?? ""}>
              {currentSessionId?.slice(0, 12)}
            </span>
          )}
          <span className={`status-tag ${tag.tone}`}>[{tag.text}]</span>
        </header>

        {!isLive ? (
          <div className="setup">
            <p className="setup-lead">
              Power one agent and talk to it directly in the terminal below. Baton
              watches the context window and rate limits in the background and
              relays the work to the other agent when a limit hits — same session,
              no re-explaining.
            </p>

            <label className="field">
              <span>Task</span>
              <textarea
                rows={3}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                disabled={busy}
                placeholder="what should the agent do?"
              />
            </label>

            <label className="field">
              <span>Workspace</span>
              {hasNativePicker ? (
                <div className="input-row">
                  <input
                    value={workspaceDir}
                    onChange={(e) => setWorkspaceDir(e.target.value)}
                    disabled={busy}
                    placeholder="path the agents work in"
                  />
                  <button type="button" className="ghost" onClick={browseWorkspace} disabled={busy}>
                    Browse…
                  </button>
                </div>
              ) : (
                <input
                  value={workspaceDir}
                  onChange={(e) => setWorkspaceDir(e.target.value)}
                  disabled={busy}
                  placeholder="path the agents work in"
                />
              )}
            </label>

            <div className="setup-grid">
              <label className="field">
                <span>Start with</span>
                <select
                  value={initialAgent}
                  onChange={(e) => setInitialAgent(e.target.value as AgentId)}
                  disabled={busy}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <label className="field">
                <span>Verify with</span>
                <input
                  value={verificationCommand}
                  onChange={(e) => setVerificationCommand(e.target.value)}
                  disabled={busy}
                  placeholder="npm test"
                />
              </label>
            </div>

            <button
              className="primary"
              onClick={startNewSession}
              disabled={busy || workspaceDir.trim().length === 0}
            >
              {pendingAction?.startsWith("start") ? (
                <span className="spinner light" />
              ) : (
                <Icon name="spark" size={14} />
              )}
              Start Baton
            </button>

            <details className="advanced">
              <summary>Advanced — provider login & models</summary>
              <div className="advanced-fields">
                <p className="advanced-note">
                  For the real CLIs only. Leave blank to use your existing sessions:
                  open <code>claude</code> once to sign in, run <code>codex login</code> for
                  Codex. Keys go only to the local server for this run.
                </p>
                <label className="field">
                  <span>Anthropic API key</span>
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder="sk-ant-…"
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  <span>OpenAI API key</span>
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder="sk-…"
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <div className="setup-grid">
                  <label className="field">
                    <span>Claude model</span>
                    <input value={claudeModel} onChange={(e) => setClaudeModel(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Codex model</span>
                    <input
                      value={codexModel}
                      onChange={(e) => setCodexModel(e.target.value)}
                      placeholder="blank = account default"
                    />
                  </label>
                </div>
                <label className="field">
                  <span>API</span>
                  <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
                </label>
              </div>
            </details>
          </div>
        ) : (
          <>
            <div className="term-wrap">
              <div className="term-host" ref={termHost} />
              {status !== "open" && (
                <div className="term-status">
                  {status === "error" || status === "closed"
                    ? `broadcaster unavailable (${wsBase}) — start the server`
                    : `connecting to ${wsBase}…`}
                </div>
              )}
            </div>

            <div className="activity" title={activity}>
              {activity}
            </div>

            <Telemetry
              phase={phase}
              tokens={usage.tokens}
              window={usage.window}
              pct={usage.pct}
              rate={rate}
              migration={migration}
              verifyCommand={verificationCommand}
              onVerify={() => sessionAction("verify", "/verify")}
              verifyDisabled={actionsLocked}
              bench={bench}
            />

            {controlMessage && <div className="control-message">{controlMessage}</div>}

            <div className="footerbar">
              <button
                type="button"
                className="force"
                onClick={() => switchAgent(switchTarget)}
                disabled={actionsLocked}
                title={`Compress current state and relay to ${agentLabel(switchTarget)} now`}
              >
                <Icon name="relay" size={15} />
                <span>
                  {sessionComplete
                    ? "Session complete"
                    : sessionFailed
                      ? "Session failed"
                      : phase === "switching"
                        ? "Relaying…"
                        : `Force handoff → ${agentLabel(switchTarget)}`}
                </span>
              </button>
            </div>
          </>
        )}
      </aside>
    </main>
  );
}
