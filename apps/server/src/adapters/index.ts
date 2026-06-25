/**
 * Relay server — agent adapters barrel.
 * The import surface for the adapter contract and the bundled implementations.
 *   import { AgentAdapter, FakeAgentAdapter } from "./adapters";
 */

export * from "./types";
export * from "./fake";
export * from "./process-agent";
export * from "./claude";
export * from "./codex";
export * from "./pty-agent";
export * from "./claude-interactive";
export * from "./codex-interactive";
