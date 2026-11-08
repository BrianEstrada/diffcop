import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { tool } from "ai";
import { createLocalSandbox } from "ai-sdk-sandbox-local";
import { z } from "zod";
import { ExplorationLog, explorationCall } from "@/agent/explored";
import type {
  AgentResult,
  AgentRun,
  ReviewerAgent,
  RunStats,
} from "@/agent/reviewer-agent";
import { sumStats } from "@/agent/reviewer-agent";

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
export const finishCost = z
  .object({
    providerMetadata: z.object({
      "claude-code": z.object({ costUsd: z.number() }),
    }),
  })
  .transform((part) => {
    return part.providerMetadata["claude-code"].costUsd;
  });

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

// Claude Code's own `outputFormat` tool, StructuredOutput, waits for a host
// approval under "allow-reads" that activeTools then denies, so the answer
// comes back through a host tool instead, which skips approval.
export const SUBMIT_TOOL = "submit_result";

export const SUBMIT_INSTRUCTION = `When you're done, call ${SUBMIT_TOOL} once with your answer. Your text replies are not read.`;

export const SUBMIT_REMINDER = `You ended without calling ${SUBMIT_TOOL}. Call it now with your answer.`;

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
    let submitted: { answer: T } | undefined;
    const agent = new HarnessAgent({
      harness: createClaudeCode({
        maxTurns: this.#options.maxTurns,
        effort: this.#options.effort,
        // The local sandbox predates `getPortEndpoint`, so pass the bridge port
        // and endpoint explicitly.
        port: port,
        portEndpoint: { url: `ws://127.0.0.1:${port}` },
        // Tool search would otherwise hide the tool until the model looks it up.
        toolHints: {
          [SUBMIT_TOOL]: {
            readOnly: true,
            alwaysLoad: true,
          },
        },
      }),
      model: this.#options.model,
      instructions: `${prompt.instructions}\n\n${SUBMIT_INSTRUCTION}`,
      permissionMode: "allow-reads",
      activeTools: [...REVIEWER_TOOLS, SUBMIT_TOOL],
      tools: {
        [SUBMIT_TOOL]: tool({
          description:
            "Submit your final answer. Call it once, as your last step.",
          inputSchema: output,
          execute: (answer) => {
            submitted = { answer: answer };
            return "Submitted. End your turn.";
          },
        }),
      },
      // Root the session at `cwd` itself, not a per-session subdirectory.
      sandboxConfig: { workDir: "." },
    });

    const sandboxSession = await createLocalSandbox({
      cwd: cwd,
    }).createSession();
    const session = await agent.createSession({
      sandboxSession: sandboxSession,
    });

    let toolCalls = 0;
    const exploration = new ExplorationLog(cwd);
    async function turn(content: string[]) {
      const result = await agent.stream({
        session: session,
        abortSignal: abortSignal,
        messages: [
          {
            role: "user",
            content: content.map((text) => {
              return {
                type: "text",
                text: text,
              };
            }),
          },
        ],
      });

      // Text replies are narration, so only progress is reported.
      let thinkingSince: number | undefined;
      let costUsd: number | undefined;
      for await (const part of result.stream) {
        switch (part.type) {
          case "tool-call": {
            if (part.toolName === SUBMIT_TOOL) {
              break;
            }
            toolCalls++;
            const call = explorationCall.safeParse(part);
            if (call.success) {
              exploration.record(call.data);
            }
            reporter.toolCall(part.toolName, JSON.stringify(part.input));
            break;
          }
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
            costUsd = finishCost.safeParse(part).data;
            break;
          case "error":
            throw part.error;
        }
      }
      const usage = await result.usage;
      return {
        usage: usage,
        costUsd: costUsd,
      };
    }

    try {
      const turns = [await turn(prompt.content)];
      if (submitted === undefined) {
        turns.push(await turn([SUBMIT_REMINDER]));
      }
      if (submitted === undefined) {
        throw new Error(
          `The reviewer ended twice without calling ${SUBMIT_TOOL}.`,
        );
      }

      const stats = turns
        .map(({ usage, costUsd }): RunStats => {
          return {
            durationMs: 0,
            toolCalls: 0,
            inputTokens: usage.inputTokens,
            cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
            outputTokens: usage.outputTokens,
            costUsd: costUsd,
          };
        })
        .reduce(sumStats);
      return {
        // Model output, so checked here too rather than trusting the tool's check.
        output: output.parse(submitted.answer),
        stats: {
          ...stats,
          durationMs: performance.now() - startedAt,
          toolCalls: toolCalls,
        },
        explored: exploration.explored(),
      };
    } finally {
      await session.destroy();
      await sandboxSession.destroy();
    }
  }
}
