import { useEffect, useRef, useState, type ReactNode } from "react";
import { demoEvents, demoPacket } from "./demo";

type Phase = "working" | "switching" | "resumed";
type LineKind = "plain" | "muted" | "prompt" | "pass" | "fail" | "relay";
type Line = { kind: LineKind; value: string };

type IconName = "arrow" | "check" | "cross" | "spark" | "shield" | "file";

const icons: Record<IconName, ReactNode> = {
  arrow: <path d="M5 12h13m-5-6 6 6-6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  cross: <path d="M6 6l12 12M18 6 6 18" />,
  spark: <path d="m12 3 1.2 5L18 9l-4.8 1L12 15l-1.2-5L6 9l4.8-1z" />,
  shield: (
    <>
      <path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5" />
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

// Claude works the bug, then hits a usage limit with the test still failing.
const claudeLines: Line[] = [
  { kind: "muted", value: "Last login: Sun Jun 21 00:14 on ttys002" },
  { kind: "prompt", value: '$ claude "make the users.age migration safe to re-run"' },
  { kind: "plain", value: "● reading relay-mock/migrate.ts" },
  { kind: "plain", value: "● editing relay-mock/migrate.ts  +18" },
  { kind: "prompt", value: "$ npm test -- migration" },
  { kind: "pass", value: "✔ shared schemas validate packet defaults" },
  { kind: "fail", value: "✖ migration remains safe when re-run" },
  { kind: "muted", value: "  SQLITE_ERROR: duplicate column name: age" },
  { kind: "fail", value: "✖ claude: API error 429 — usage limit reached" },
];

// After the handoff, Codex resumes from the packet and finishes the job.
const codexLines: Line[] = [
  { kind: "relay", value: "↪ relay: freezing workspace · 2 files · 37 lines" },
  { kind: "relay", value: "↪ relay: handoff packet ready · −93% · 1,218 tokens" },
  { kind: "prompt", value: "$ codex resume --packet relay-7f3a.json" },
  { kind: "plain", value: "● failure memory loaded — don't retry ALTER blindly" },
  { kind: "plain", value: "● guarding schema with PRAGMA table_info(users)" },
  { kind: "prompt", value: "$ npm test -- migration" },
  { kind: "pass", value: "✔ migration remains safe when re-run" },
  { kind: "pass", value: "✔ existing user rows remain unchanged" },
  { kind: "prompt", value: "$ npm test && npm run typecheck" },
  { kind: "pass", value: "✔ all checks passed" },
];

function Terminal({ lines, phase }: { lines: Line[]; phase: Phase }) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <section className="terminal" aria-label="Live terminal">
      <header className="terminal-bar">
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
        <span className="terminal-title">relay — zsh</span>
        <span className="terminal-branch">syed/control-tower-ui</span>
      </header>
      <div className="terminal-body" ref={bodyRef}>
        {lines.map((line, i) => (
          <div className={`line ${line.kind}`} key={i}>
            {line.value || " "}
          </div>
        ))}
        {phase !== "switching" && <span className="cursor" />}
      </div>
    </section>
  );
}

function Rail({
  phase,
  handoffDone,
  onSwitch,
}: {
  phase: Phase;
  handoffDone: boolean;
  onSwitch: () => void;
}) {
  const agent =
    phase === "resumed"
      ? { name: "Codex", model: "GPT-5", letter: "X", tone: "codex" }
      : { name: "Claude", model: "Opus 4.8", letter: "C", tone: "claude" };

  const status =
    phase === "switching"
      ? "relaying context…"
      : phase === "resumed"
        ? "resumed · working"
        : "usage limit reached";

  return (
    <aside className="rail" aria-label="Relay">
      <header className="rail-head">
        <span className="dot" />
        <strong>Relay</strong>
        <span className="session">session 7f3a</span>
      </header>

      <div className="rail-body">
        <div className="agent">
          <span className={`glyph ${agent.tone} ${phase}`}>{agent.letter}</span>
          <div>
            <small>ACTIVE AGENT</small>
            <strong>{agent.name}</strong>
            <span className={`status ${phase}`}>{status}</span>
          </div>
        </div>

        <div className="block">
          <small>TASK</small>
          <p>{demoPacket.task.goal}</p>
        </div>

        <div className={`packet ${handoffDone ? "shown" : ""}`}>
          <div className="packet-top">
            <span>
              Claude <Icon name="arrow" size={12} /> Codex
            </span>
            <b>−93%</b>
          </div>
          <div className="packet-meta">
            <span>
              <Icon name="file" size={12} /> 2 files
            </span>
            <span>
              <Icon name="spark" size={12} /> 1,218 tok
            </span>
            <span>
              <Icon name="shield" size={12} /> memory kept
            </span>
          </div>
        </div>

        <div className="block verify">
          <small>VERIFICATION</small>
          <div className="check">
            <span className="ok">
              <Icon name="check" size={12} />
            </span>
            TypeScript
          </div>
          <div className="check">
            <span className={phase === "resumed" ? "ok" : "bad"}>
              <Icon name={phase === "resumed" ? "check" : "cross"} size={12} />
            </span>
            Migration test
          </div>
        </div>
      </div>

      <footer className="rail-foot">
        <button
          className="switch"
          onClick={onSwitch}
          disabled={phase !== "working"}
        >
          {phase === "working" && (
            <>
              <Icon name="spark" size={14} /> Create handoff
            </>
          )}
          {phase === "switching" && (
            <>
              <span className="spinner" /> Relaying…
            </>
          )}
          {phase === "resumed" && (
            <>
              <Icon name="check" size={14} /> Handoff complete
            </>
          )}
        </button>
      </footer>
    </aside>
  );
}

export function App() {
  const [phase, setPhase] = useState<Phase>("working");
  const [lines, setLines] = useState<Line[]>(claudeLines);

  function runHandoff() {
    if (phase !== "working") return;
    setPhase("switching");

    // Stream Codex's continuation into the same terminal, line by line.
    codexLines.forEach((line, i) => {
      window.setTimeout(() => {
        setLines((prev) => [...prev, line]);
        if (i === codexLines.length - 1) setPhase("resumed");
      }, 450 * (i + 1));
    });
  }

  return (
    <main className="shell">
      <div className="workspace">
        <Terminal lines={lines} phase={phase} />
        <Rail
          phase={phase}
          handoffDone={phase !== "working"}
          onSwitch={runHandoff}
        />
      </div>
      <footer className="note">
        <span>Quiet while healthy. Useful when an agent fails.</span>
        <span>
          {demoEvents.length} validated events · packet v{demoPacket.version}
        </span>
      </footer>
    </main>
  );
}
