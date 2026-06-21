/**
 * Relay server — Claude agent adapter
 * -----------------------------------
 * Runs Claude Code headless via the process runner. Print mode is one-shot, so
 * the composed prompt (or resumed handoff packet) is passed positionally.
 *
 *   claude -p --output-format text --permission-mode acceptEdits [--model <model>]
 *
 * Claude is just one `AgentAdapter` — nothing here is treated as a home base.
 */

import { ProcessAgentAdapter, type AgentLaunchPlan } from "./process-agent";
import type { AgentCapabilities, AgentStartOptions } from "./types";

const DEFAULT_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6"];

export class ClaudeAdapter extends ProcessAgentAdapter {
  readonly agent = "claude" as const;
  protected readonly defaultExecutable = "claude";

  capabilities(): AgentCapabilities {
    return {
      id: "claude",
      displayName: "Claude Code",
      supportsInput: false,
      supportsResume: true,
      models: this.config.models ?? DEFAULT_MODELS,
      contextWindow: 200_000,
    };
  }

  protected plan(opts: AgentStartOptions): AgentLaunchPlan {
    // Text keeps the live log human-readable. acceptEdits lets the headless
    // coding run modify the selected workspace without an invisible prompt.
    const args = [
      "-p",
      "--output-format",
      "text",
      "--permission-mode",
      "acceptEdits",
    ];
    if (opts.model) args.push("--model", opts.model);
    const prompt = this.composePrompt(opts);
    args.push(prompt);
    return { command: this.executable, args, promptForUsage: prompt };
  }
}

/** A ready-to-use instance with provider defaults. */
export const claudeAdapter = new ClaudeAdapter();
