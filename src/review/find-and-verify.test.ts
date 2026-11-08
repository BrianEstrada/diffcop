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
    const answer = this.#answers[this.runs.length - 1];
    if (answer instanceof Error) {
      throw answer;
    }
    return {
      output: run.output.parse(answer),
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

const warnings: string[] = [];

const silent: ReviewReporter = {
  started: async () => {},
  warning: async (message) => {
    warnings.push(message);
  },
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

  test("keeps the other finders' findings when one fails, and warns", async () => {
    warnings.length = 0;
    const agent = new FakeAgent([
      new Error("never submitted"),
      {
        summary: "Traced b.",
        findings: [finding("B")],
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
    ).run(context, [
      {
        ...prompt,
        files: ["a.ts"],
      },
      prompt,
    ]);

    expect(result.findings).toEqual([finding("B")]);
    expect(result.summary).toBe("Traced b.");
    expect(result.finders?.[0]).toEqual({
      files: ["a.ts"],
      findings: 0,
      error: "never submitted",
    });
    expect(warnings).toEqual([
      "A finder for a.ts failed, so those files got one review fewer: never submitted",
    ]);
  });

  test("verifies the findings undeduplicated when dedupe fails, and warns", async () => {
    warnings.length = 0;
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [finding("A")],
      },
      {
        summary: "",
        findings: [finding("B")],
      },
      new Error("never submitted"),
      {
        verdicts: [
          {
            id: 1,
            verdict: "confirmed",
            reason: "Fails.",
          },
          {
            id: 2,
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
    ).run(context, [prompt, prompt]);

    expect(result.findings).toEqual([finding("A"), finding("B")]);
    expect(warnings).toEqual([
      "Merging duplicate findings failed, so some may be listed twice: never submitted",
    ]);
  });

  test("fails when every finder fails", async () => {
    const agent = new FakeAgent([new Error("first"), new Error("second")]);

    expect(
      new FindAndVerify(new ReviewPromptBuilder(), agent, silent).run(context, [
        prompt,
        prompt,
      ]),
    ).rejects.toThrow("first");
  });
});
