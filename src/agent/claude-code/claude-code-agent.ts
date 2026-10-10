import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { Output } from "ai";
import { createLocalSandbox } from "ai-sdk-sandbox-local";
import { z } from "zod";
import { ExplorationLog } from "../explored";
import type {
  AgentResult,
  AgentRun,
  ReviewerAgent,
  RunStats,
} from "../reviewer-agent";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof EFFORTS)[number];

export interface ClaudeCodeReviewerAgentOptions {
  model?: string;
  maxTurns?: number;
  effort?: Effort;
}

function leaseLocalPort() {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: function () {} },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
}

// Claude Code reports its cost estimate only on the turn's `finish` part, which
// the harness sends with `providerMetadata` though the AI SDK type leaves it
// out. The non-deprecated `finalStep.providerMetadata` never has it.
const finishCost = z.object({
  providerMetadata: z.object({
    "claude-code": z.object({ costUsd: z.number() }),
  }),
});

export function costFrom(finishPart: unknown) {
  return finishCost.safeParse(finishPart).data?.providerMetadata["claude-code"]
    .costUsd;
}

// Read-only by design: never add write or shell tools here. Under
// "allow-reads" any other tool waits for an approval nothing grants.
export const REVIEWER_TOOLS = ["read", "glob", "grep"] as const;

// diffcop never answers approval requests, so the run would end without a
// review; fail instead of posting an empty one.
export function approvalRequestError(toolName: string) {
  return new Error(
    `The reviewer asked to use ${toolName}, which needs an approval diffcop can't give. Only ${REVIEWER_TOOLS.join(", ")} are allowed.`,
  );
}

export class ClaudeCodeReviewerAgent implements ReviewerAgent {
  readonly #options: ClaudeCodeReviewerAgentOptions;

  constructor(options: ClaudeCodeReviewerAgentOptions = {}) {
    this.#options = options;
  }

  async run<T>({
    cwd,
    prompt,
    output,
    reporter,
    abortSignal,
  }: AgentRun<T>): Promise<AgentResult<T>> {
    const startedAt = performance.now();
    const port = leaseLocalPort();
    const agent = new HarnessAgent({
      harness: createClaudeCode({
        maxTurns: this.#options.maxTurns,
        effort: this.#options.effort,
        // The local sandbox predates `getPortEndpoint`, so pass the bridge port
        // and endpoint explicitly.
        port: port,
        portEndpoint: { url: `ws://127.0.0.1:${port}` },
      }),
      model: this.#options.model,
      instructions: prompt.instructions,
      permissionMode: "allow-reads",
      activeTools: [...REVIEWER_TOOLS],
      // Root the session at `cwd` itself, not a per-session subdirectory.
      sandboxConfig: { workDir: "." },
      // Claude Code's `outputFormat`: the final answer is a schema-checked object.
      output: Output.object({ schema: output }),
    });

    const sandboxSession = await createLocalSandbox({
      cwd: cwd,
    }).createSession();
    const session = await agent.createSession({
      sandboxSession: sandboxSession,
    });

    try {
      const result = await agent.stream({
        session: session,
        abortSignal: abortSignal,
        messages: [
          {
            role: "user",
            content: prompt.content.map((text) => {
              return {
                type: "text",
                text: text,
              };
            }),
          },
        ],
      });

      // Text before the structured answer is narration, so only progress is reported.
      let toolCalls = 0;
      let thinkingSince: number | undefined;
      let costUsd: number | undefined;
      const exploration = new ExplorationLog(cwd);
      for await (const part of result.stream) {
        switch (part.type) {
          case "tool-call":
            toolCalls++;
            exploration.record(part.toolName, part.input);
            reporter.toolCall(part.toolName, part.input);
            break;
          case "reasoning-start":
            thinkingSince = performance.now();
            break;
          case "reasoning-end":
            if (thinkingSince !== undefined) {
              reporter.thinking(performance.now() - thinkingSince);
              thinkingSince = undefined;
            }
            break;
          case "tool-approval-request":
            throw approvalRequestError(part.toolCall.toolName);
          case "finish":
            costUsd = costFrom(part);
            break;
          case "error":
            throw part.error;
        }
      }

      const [usage, answer] = await Promise.all([result.usage, result.output]);
      const stats: RunStats = {
        durationMs: performance.now() - startedAt,
        toolCalls: toolCalls,
        inputTokens: usage.inputTokens,
        cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
        outputTokens: usage.outputTokens,
        costUsd: costUsd,
      };
      return {
        // Model output, so checked here too rather than trusting the harness's check.
        output: output.parse(answer),
        stats: stats,
        explored: exploration.explored(),
      };
    } finally {
      await session.destroy();
      await sandboxSession.destroy();
    }
  }
}
