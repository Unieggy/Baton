/**
 * Relay server — interactive Claude adapter (PTY)
 * -----------------------------------------------
 * Runs the real `claude` TUI inside a pseudo-terminal — NOT print/one-shot mode —
 * so the live session, multi-turn memory, and approval prompts all behave exactly
 * as in a normal terminal. The opening task (or a resumed handoff packet) is
 * passed as the positional initial prompt.
 *
 *   claude [--model <model>] "<prompt>"
 */

import { PtyAgentAdapter, type PtyLaunchPlan } from "./pty-agent";
import type { AgentCapabilities, AgentStartOptions } from "./types";

const DEFAULT_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6"];

export class ClaudeInteractiveAdapter extends PtyAgentAdapter {
  readonly agent = "claude" as const;
  protected readonly defaultExecutable = "claude";

  capabilities(): AgentCapabilities {
    return {
      id: "claude",
      displayName: "Claude Code",
      supportsInput: true,
      supportsResume: true,
      models: this.config.models ?? DEFAULT_MODELS,
      contextWindow: 200_000,
    };
  }

  protected plan(opts: AgentStartOptions): PtyLaunchPlan {
    const args: string[] = [];
    if (opts.model) args.push("--model", opts.model);
    const prompt = this.composePrompt(opts);
    if (prompt) args.push(prompt); // positional initial prompt → interactive session
    return { command: this.executable, args, promptForUsage: prompt };
  }
}

export const claudeInteractiveAdapter = new ClaudeInteractiveAdapter();
