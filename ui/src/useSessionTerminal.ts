import { useEffect, useRef, useState, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { RelayEvent, type RelayEvent as RelayEventT } from "../../packages/shared";
import { mergeRelayEvents, type StreamStatus } from "./useRelayStream";

export interface SessionTerminal {
  events: RelayEventT[];
  status: StreamStatus;
}

const DIM = "\x1b[38;5;245m";
const RESET = "\x1b[0m";

function cap(agent: unknown): string {
  return agent === "codex" ? "Codex" : "Claude";
}

/** Baton lifecycle events rendered inline as dim divider lines in the stream. */
function systemLine(e: RelayEventT): string | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "limit.detected":
      return `Baton: usage limit (${String(p.reason ?? "limit")}) — relaying`;
    case "agent.switched":
      return `Baton relayed ${cap(p.from)} → ${cap(p.to)}`;
    case "handoff.created":
      return "Baton: handoff packet ready";
    case "agent.launching":
      return p.resumed ? `Resuming ${cap(p.target ?? p.to)} from handoff` : null;
    case "test.passed":
      return `Verified — ${String(p.command ?? "tests")} passed`;
    case "test.failed":
      return `Verification failed — ${String(p.command ?? "tests")}`;
    case "session.completed":
      return "Task complete — verification passed";
    case "session.failed":
      return `Session failed${p.error ? ` — ${String(p.error)}` : ""}`;
    case "handoff.failed":
      return `Handoff failed${p.error ? ` — ${String(p.error)}` : ""}`;
    default:
      return null;
  }
}

/**
 * Bind a session to an xterm terminal over a single bidirectional WebSocket:
 * agent output (and Baton dividers) are written to the terminal, keystrokes and
 * resizes are sent back to the PTY, and the full event timeline is returned for
 * the telemetry panel. Each event is rendered exactly once (deduped by id) so
 * reconnects/replays never double-print.
 */
export function useSessionTerminal(
  sessionId: string | null,
  host: RefObject<HTMLDivElement | null>,
  base = "ws://127.0.0.1:4000",
  apiBase = "http://127.0.0.1:4000"
): SessionTerminal {
  const [events, setEvents] = useState<RelayEventT[]>([]);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const written = useRef<Set<string>>(new Set());
  const socketRef = useRef<WebSocket | null>(null);

  // Create the terminal once a host element + session exist.
  useEffect(() => {
    if (!sessionId || !host.current) return;
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", "Cascadia Code", Consolas, monospace',
      fontSize: 12,
      scrollback: 8000,
      theme: {
        background: "#17171c",
        foreground: "#d4d4d8",
        cursor: "#d4d4d8",
        selectionBackground: "#3a3a44",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    try {
      fit.fit();
    } catch {
      /* host not laid out yet */
    }
    termRef.current = term;
    fitRef.current = fit;
    written.current = new Set();

    const sendResize = (): void => {
      const ws = socketRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    const onData = term.onData((data) => {
      const ws = socketRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "stdin", data }));
      }
    });
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sendResize();
      } catch {
        /* mid-teardown */
      }
    });
    ro.observe(host.current);

    return () => {
      onData.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, host]);

  // Own the WebSocket: hydrate history, stream live, render once per event id.
  useEffect(() => {
    if (!sessionId) {
      setStatus("idle");
      return;
    }
    setEvents([]);
    setStatus("connecting");
    const url = `${base.replace(/\/$/, "")}/ws/sessions/${encodeURIComponent(sessionId)}`;
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempts = 0;

    const render = (e: RelayEventT): void => {
      const term = termRef.current;
      if (!term || written.current.has(e.id)) return;
      written.current.add(e.id);
      if (e.type === "terminal.output") {
        term.write(String((e.payload as { chunk?: string }).chunk ?? ""));
        return;
      }
      const line = systemLine(e);
      if (line) term.write(`\r\n${DIM}── ${line} ──${RESET}\r\n`);
    };

    const consume = (incoming: RelayEventT[]): void => {
      for (const e of incoming) render(e);
      setEvents((prev) => mergeRelayEvents(prev, incoming));
    };

    const hydrate = async (): Promise<void> => {
      try {
        const res = await fetch(
          `${apiBase.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sessionId)}/events`
        );
        if (!res.ok) return;
        const body = (await res.json()) as { events?: unknown[] };
        const history = (body.events ?? [])
          .map((e) => RelayEvent.safeParse(e))
          .filter((r) => r.success)
          .map((r) => r.data);
        if (!cancelled) consume(history);
      } catch {
        /* live stream still works without replay */
      }
    };

    const connect = (): void => {
      if (cancelled) return;
      setStatus("connecting");
      const ws = new WebSocket(url);
      socketRef.current = ws;
      ws.onopen = () => {
        attempts = 0;
        setStatus("open");
        const term = termRef.current;
        if (term && socketRef.current?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
        }
        void hydrate();
      };
      ws.onmessage = (event) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const result = RelayEvent.safeParse(parsed);
        if (result.success) consume([result.data]);
      };
      ws.onerror = () => {
        if (!cancelled) setStatus("error");
      };
      ws.onclose = () => {
        if (cancelled) return;
        setStatus("closed");
        const delay = Math.min(4000, 250 * 2 ** attempts++);
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [sessionId, base, apiBase]);

  return { events, status };
}
