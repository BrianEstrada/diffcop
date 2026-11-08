import { describe, expect, test } from "bun:test";
import type { AgentRun, ReviewerAgent } from "@/agent/reviewer-agent";
import type { ReviewContext } from "@/context/review-context-collector";
import { ReviewPromptBuilder } from "@/prompt/review-prompt-builder";
import type { ReviewReporter } from "@/reporter/review-reporter";
import { FindAndVerify } from "@/review/find-and-verify";
import type { Finding } from "@/review/findings";

function finding(title: string): Finding {
  return {
    file: "a.ts",
    startLine: 1,
    endLine: 1,
    severity: "high",
    scope: "introduced",
    title: title,
    explanation: "Throws on [].",
  };
}

class FakeAgent implements ReviewerAgent {
  readonly runs: AgentRun<unknown>[] = [];
  readonly #answers: unknown[];

  constructor(answers: unknown[]) {
    this.#answers = answers;
  }

  async run<T>(run: AgentRun<T>) {
    this.runs.push(run);
    return {
      output: run.output.parse(this.#answers[this.runs.length - 1]),
      stats: {
        durationMs: 1_000,
        toolCalls: 1,
      },
      explored: {
        filesRead: [],
        searches: [],
      },
    };
  }
}

const silent: ReviewReporter = {
  started: async () => {},
  warning: async () => {},
  toolCall: () => {},
  thinking: () => {},
  verifying: async () => {},
  completed: async () => {},
  failed: async () => {},
};

const context: ReviewContext = {
  repoRoot: "/repo",
  branch: "feature",
  base: "main",
  mergeBase: "abc",
  commits: [],
  changedFiles: [],
  diff: "",
};

const prompt = {
  prompt: {
    instructions: "Find bugs.",
    content: ["x"],
  },
};

describe("FindAndVerify", () => {
  test("counts each finder's findings after `keep`", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [finding("A"), finding("B")],
      },
      {
        summary: "",
        findings: [],
      },
      {
        verdicts: [
          {
            id: 1,
            verdict: "confirmed",
            reason: "Fails.",
          },
        ],
      },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(context, [prompt, prompt], {
      keep: (kept) => {
        return kept.title === "A";
      },
    });

    expect(result.findings).toEqual([finding("A")]);
    expect(
      result.finders?.map(({ findings }) => {
        return findings;
      }),
    ).toEqual([1, 0]);
  });
});
