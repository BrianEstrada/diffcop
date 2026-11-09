import { beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import {
  approvalRequestError,
  ClaudeCodeReviewerAgent,
  DENIAL_REASON,
  finishCost,
  MAX_DENIED_TURNS,
  REVIEWER_TOOLS,
  SUBMIT_REMINDER,
  SUBMIT_TOOL,
} from "@/agent/claude-code/claude-code-agent";
import type { ReviewReporter } from "@/reporter/review-reporter";

interface Answer {
  ok: boolean;
}

interface FakeSettings {
  instructions: string;
  activeTools: string[];
  tools: Record<string, { execute: (input: Answer) => string }>;
}

// An approval request a turn pauses on, instead of finishing.
interface Asks {
  asks: string;
}

// What each turn submits; undefined ends the turn without submitting.
let turns: (Answer | Asks | undefined)[] = [];
let sent: unknown[] = [];
let instructions: string[] = [];

// Bun swaps the binding the agent module already imported.
await mock.module("@ai-sdk/harness/agent", () => {
  return {
    HarnessAgent: class {
      readonly #settings: FakeSettings;

      constructor(settings: FakeSettings) {
        this.#settings = settings;
        instructions.push(settings.instructions);
      }

      async createSession() {
        return { destroy: async () => {} };
      }

      async stream({ messages }: { messages: unknown[] }) {
        sent.push(messages);
        const answer = turns.shift();
        const parts: unknown[] = [];
        if (answer !== undefined && "asks" in answer) {
          parts.push({
            type: "tool-approval-request",
            approvalId: `approval-${sent.length}`,
            toolCall: {
              toolCallId: `call-${sent.length}`,
              toolName: answer.asks,
              input: { path: "/elsewhere" },
            },
          });
          return {
            stream: (async function* () {
              yield* parts;
            })(),
            usage: Promise.resolve({
              inputTokens: 10,
              outputTokens: 5,
              inputTokenDetails: { cacheReadTokens: 2 },
            }),
          };
        }
        if (answer !== undefined) {
          parts.push({
            type: "tool-call",
            toolName: SUBMIT_TOOL,
            input: answer,
          });
          this.#settings.tools[SUBMIT_TOOL]?.execute(answer);
        }
        parts.push({
          type: "finish",
          providerMetadata: { "claude-code": { costUsd: 0.1 } },
        });
        return {
          stream: (async function* () {
            yield* parts;
          })(),
          usage: Promise.resolve({
            inputTokens: 10,
            outputTokens: 5,
            inputTokenDetails: { cacheReadTokens: 2 },
          }),
        };
      }
    },
  };
});

await mock.module("ai-sdk-sandbox-local", () => {
  return {
    createLocalSandbox: () => {
      return {
        createSession: async () => {
          return { destroy: async () => {} };
        },
      };
    },
  };
});

describe("REVIEWER_TOOLS", () => {
  test("only grants read-only tools", () => {
    expect([...REVIEWER_TOOLS]).toEqual(["read", "glob", "grep"]);
  });
});

describe("approvalRequestError", () => {
  test("names the denied tool and the allowed ones", () => {
    expect(approvalRequestError("glob").message).toBe(
      "The reviewer kept asking to use glob outside what diffcop allows, after 5 denials. Only read, glob, grep inside the repository are allowed.",
    );
  });
});

describe("finishCost", () => {
  test("reads Claude Code's cost estimate from the finish part", () => {
    expect(
      finishCost.safeParse({
        type: "finish",
        providerMetadata: { "claude-code": { costUsd: 0.42 } },
      }).data,
    ).toBe(0.42);
  });

  test("is undefined when the finish part has no usable cost", () => {
    expect(finishCost.safeParse({ type: "finish" }).data).toBeUndefined();
    expect(
      finishCost.safeParse({
        type: "finish",
        providerMetadata: { "claude-code": {} },
      }).data,
    ).toBeUndefined();
    expect(
      finishCost.safeParse({
        type: "finish",
        providerMetadata: { "claude-code": { costUsd: "0.42" } },
      }).data,
    ).toBeUndefined();
  });
});

const silent: ReviewReporter = {
  started: async () => {},
  warning: async () => {},
  toolCall: () => {},
  thinking: () => {},
  verifying: async () => {},
  completed: async () => {},
  failed: async () => {},
};

function review() {
  return new ClaudeCodeReviewerAgent().run({
    cwd: "/repo",
    prompt: {
      instructions: "Find bugs.",
      content: ["x"],
    },
    output: z.object({ ok: z.boolean() }),
    reporter: silent,
  });
}

describe("ClaudeCodeReviewerAgent", () => {
  beforeEach(() => {
    turns = [];
    sent = [];
    instructions = [];
  });

  test("returns what the reviewer submits", async () => {
    turns = [{ ok: true }];
    const result = await review();
    expect(result.output).toEqual({ ok: true });
    expect(result.stats.toolCalls).toBe(0);
    expect(result.stats.costUsd).toBe(0.1);
    expect(sent).toHaveLength(1);
    expect(instructions[0]).toContain(SUBMIT_TOOL);
  });

  test("reminds a reviewer that ends without submitting, and sums both turns", async () => {
    turns = [undefined, { ok: false }];
    const result = await review();
    expect(result.output).toEqual({ ok: false });
    expect(JSON.stringify(sent[1])).toContain(SUBMIT_REMINDER);
    expect(result.stats).toMatchObject({
      inputTokens: 20,
      cacheReadTokens: 4,
      outputTokens: 10,
      costUsd: 0.2,
    });
  });

  test("denies a read outside the repository and lets the reviewer carry on", async () => {
    turns = [{ asks: "glob" }, { ok: true }];
    const result = await review();
    expect(result.output).toEqual({ ok: true });
    expect(sent[1]).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "glob",
            input: { path: "/elsewhere" },
            providerExecuted: true,
          },
          {
            type: "tool-approval-request",
            approvalId: "approval-1",
            toolCallId: "call-1",
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: "approval-1",
            approved: false,
            reason: DENIAL_REASON,
          },
        ],
      },
    ]);
    // The paused turn sends no cost, so only the finished one counts.
    expect(result.stats.costUsd).toBe(0.1);
  });

  test("fails when the reviewer keeps asking after every denial", async () => {
    turns = Array.from({ length: MAX_DENIED_TURNS + 1 }, () => {
      return { asks: "glob" };
    });
    expect(review()).rejects.toThrow(approvalRequestError("glob").message);
  });

  test("fails when the reviewer ends twice without submitting", async () => {
    turns = [undefined, undefined];
    expect(review()).rejects.toThrow(
      `The reviewer ended twice without calling ${SUBMIT_TOOL}.`,
    );
  });
});
