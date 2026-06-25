/**
 * Relay server — interactive Codex adapter (PTY)
 * ----------------------------------------------
 * Runs the real `codex` TUI inside a pseudo-terminal — NOT `codex exec` one-shot —
 * so the live session, memory, and approval prompts behave as in a terminal. The
 * PTY's cwd is the workspace; the opening task (or resumed handoff packet) is the
 * positional initial prompt.
 *
 *   codex [-m <model>] "<prompt>"
 */

import { PtyAgentAdapter, type PtyLaunchPlan } from "./pty-agent";
import type { AgentCapabilities, AgentStartOptions } from "./types";

const DEFAULT_MODELS = ["gpt-5-codex"];

/** Only pass `-m` when the id is actually a Codex/OpenAI model. */
function codexModelArg(model: string | undefined): string[] {
  return model && /^(gpt|o\d|codex)/i.test(model) ? ["-m", model] : [];
}

export class CodexInteractiveAdapter extends PtyAgentAdapter {
  readonly agent = "codex" as const;
  protected readonly defaultExecutable = "codex";

  capabilities(): AgentCapabilities {
    return {
      id: "codex",
      displayName: "Codex CLI",
      supportsInput: true,
      supportsResume: true,
      models: this.config.models ?? DEFAULT_MODELS,
      contextWindow: 272_000,
    };
  }

  protected plan(opts: AgentStartOptions): PtyLaunchPlan {
    const prompt = this.composePrompt(opts);
    const args = [...codexModelArg(opts.model)];
    if (prompt) args.push(prompt); // positional initial prompt → interactive session
    return { command: this.executable, args, promptForUsage: prompt };
  }
}

export const codexInteractiveAdapter = new CodexInteractiveAdapter();
