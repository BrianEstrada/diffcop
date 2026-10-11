import type { z } from "zod";
import type { ReviewPrompt } from "@/prompt/review-prompt-builder";
import type { ReviewReporter } from "@/reporter/review-reporter";
import type { Explored } from "@/agent/explored";

export interface RunStats {
  durationMs: number;
  toolCalls: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface AgentRun<T> {
  cwd: string;
  prompt: ReviewPrompt;
  // The agent answers with an object matching this schema.
  output: z.ZodType<T>;
  reporter: ReviewReporter;
  abortSignal?: AbortSignal;
}

export interface AgentResult<T> {
  output: T;
  stats: RunStats;
  explored: Explored;
}

export interface ReviewerAgent {
  run<T>(run: AgentRun<T>): Promise<AgentResult<T>>;
}

// A count only one run reported is left out rather than understated.
function sumKnown(a: number | undefined, b: number | undefined) {
  if (a === undefined || b === undefined) {
    return undefined;
  }
  return a + b;
}

export function sumStats(a: RunStats, b: RunStats): RunStats {
  return {
    durationMs: a.durationMs + b.durationMs,
    toolCalls: a.toolCalls + b.toolCalls,
    inputTokens: sumKnown(a.inputTokens, b.inputTokens),
    cacheReadTokens: sumKnown(a.cacheReadTokens, b.cacheReadTokens),
    outputTokens: sumKnown(a.outputTokens, b.outputTokens),
    costUsd: sumKnown(a.costUsd, b.costUsd),
  };
}
