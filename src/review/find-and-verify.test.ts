import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AgentRun, ReviewerAgent } from "@/agent/reviewer-agent";
import type { ReviewContext } from "@/context/review-context-collector";
import { ReviewPromptBuilder } from "@/prompt/review-prompt-builder";
import type { ReviewReporter } from "@/reporter/review-reporter";
import { FindAndVerify } from "@/review/find-and-verify";
import type { Finding } from "@/review/findings";
import { parseDelta } from "@/review/review-delta";
import type { LedgerEntry } from "@/review/review-ledger";

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

// Line 1 of a.ts changed since the last review; nothing else did.
const delta = parseDelta(
  "aaaaaaa",
  [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n"),
  new Set(["a.ts"]),
);

function reported(title: string): LedgerEntry {
  return {
    ...finding(title),
    status: "reported",
  };
}

function reviewedBefore(
  entries: LedgerEntry[],
  { withDelta = true } = {},
): ReviewContext {
  return {
    ...context,
    previous: {
      rounds: [
        {
          headSha: "aaaaaaa",
          entries: entries,
        },
      ],
      ...(withDelta && { delta: delta }),
    },
  };
}

function verdict(id: number, kind: string, reason = "Because.") {
  return {
    id: id,
    verdict: kind,
    reason: reason,
  };
}

function findingsSent(run: AgentRun<unknown> | undefined) {
  const block = run?.prompt.content.at(-1) ?? "";
  const json = block.slice(block.indexOf("["), block.lastIndexOf("]") + 1);
  return z
    .array(
      z.looseObject({
        title: z.string(),
        earlierRound: z.boolean().optional(),
      }),
    )
    .parse(JSON.parse(json))
    .map(({ title, earlierRound }) => {
      return [title, earlierRound ?? false];
    });
}

describe("FindAndVerify on a re-review", () => {
  test("leaves out minor findings on code that hasn't changed since the last review", async () => {
    const unchanged = {
      startLine: 50,
      endLine: 50,
    };
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [
          {
            ...finding("Minor, changed"),
            severity: "low",
          },
          {
            ...finding("Nit, unchanged"),
            ...unchanged,
            severity: "nit",
          },
          {
            ...finding("Low, unchanged"),
            ...unchanged,
            severity: "low",
          },
          {
            ...finding("Major, unchanged"),
            ...unchanged,
          },
          {
            ...finding("Description"),
            ...unchanged,
            severity: "low",
            scope: "description",
          },
        ],
      },
      {
        verdicts: [1, 2, 3].map((id) => {
          return verdict(id, "confirmed");
        }),
      },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(reviewedBefore([]), [prompt]);

    expect(
      result.findings.map(({ title }) => {
        return title;
      }),
    ).toEqual(["Minor, changed", "Major, unchanged", "Description"]);
    expect(result.rereview).toEqual({
      since: "aaaaaaa",
      settled: [],
      fixed: [],
      stillOpen: 0,
      leftOut: 2,
    });
  });

  test("keeps minor findings anywhere when the last reviewed commit can't be diffed against", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [
          {
            ...finding("Nit, anywhere"),
            startLine: 50,
            endLine: 50,
            severity: "nit",
          },
        ],
      },
      { verdicts: [verdict(1, "confirmed")] },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(reviewedBefore([], { withDelta: false }), [prompt]);

    expect(result.findings).toHaveLength(1);
    expect(result.rereview).toEqual({
      settled: [],
      fixed: [],
      stillOpen: 0,
      leftOut: 0,
    });
  });

  test("checks the last round's finding again, and keeps it while it's still there", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [],
      },
      {
        verdicts: [
          {
            ...verdict(1, "confirmed"),
            startLine: 12,
            endLine: 14,
          },
        ],
      },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(reviewedBefore([reported("Still open")]), [prompt]);

    expect(findingsSent(agent.runs[1])).toEqual([["Still open", true]]);
    expect(result.findings).toEqual([
      {
        ...finding("Still open"),
        startLine: 12,
        endLine: 14,
      },
    ]);
    expect(result.rereview).toMatchObject({
      fixed: [],
      stillOpen: 1,
    });
  });

  test("carries a minor finding over too, though the code it cites hasn't changed", async () => {
    const minor = {
      ...reported("Open nit"),
      severity: "nit" as const,
      startLine: 50,
      endLine: 50,
    };
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [],
      },
      { verdicts: [verdict(1, "confirmed")] },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(reviewedBefore([minor]), [prompt]);

    expect(findingsSent(agent.runs[1])).toEqual([["Open nit", true]]);
    expect(
      result.findings.map(({ title, severity }) => {
        return [title, severity];
      }),
    ).toEqual([["Open nit", "nit"]]);
    expect(result.rereview).toMatchObject({
      stillOpen: 1,
      leftOut: 0,
    });
  });

  test("moves a carried finding the author declined to the settled ones", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [],
      },
      { verdicts: [verdict(1, "settled", "Declined in the description.")] },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(reviewedBefore([reported("Declined")]), [prompt]);

    expect(result.findings).toEqual([]);
    expect(result.rereview).toMatchObject({
      settled: [
        {
          finding: finding("Declined"),
          reason: "Declined in the description.",
        },
      ],
      fixed: [],
      stillOpen: 0,
    });
  });

  test("reports a carried finding the code no longer has as fixed, not as dropped", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [finding("New")],
      },
      {
        duplicates: [],
      },
      {
        verdicts: [
          verdict(1, "refuted", "A guard."),
          verdict(2, "refuted", "Fixed."),
        ],
      },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(reviewedBefore([reported("Fixed since")]), [prompt]);

    expect(result.findings).toEqual([]);
    expect(result.dropped).toEqual([
      {
        finding: finding("New"),
        reason: "A guard.",
      },
    ]);
    expect(result.rereview).toMatchObject({
      fixed: [
        {
          finding: finding("Fixed since"),
          reason: "Fixed.",
        },
      ],
      stillOpen: 0,
    });
  });

  test("keeps a carried finding open when the verifier gave no clear verdict on it", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [],
      },
      { verdicts: [] },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(reviewedBefore([reported("Skipped")]), [prompt]);

    expect(result.findings).toEqual([finding("Skipped")]);
    expect(result.dropped).toEqual([]);
    expect(result.rereview).toMatchObject({
      fixed: [],
      stillOpen: 1,
    });
  });

  test("merges a carried bug a finder found again, keeping the fresh finding", async () => {
    const fresh = {
      ...finding("Found again"),
      startLine: 30,
      endLine: 31,
    };
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [fresh],
      },
      {
        duplicates: [
          {
            id: 1,
            duplicateOf: 2,
          },
        ],
      },
      { verdicts: [verdict(1, "confirmed")] },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(reviewedBefore([reported("Carried")]), [prompt]);

    expect(agent.runs[1]?.prompt.instructions).toContain("without using tools");
    expect(findingsSent(agent.runs[2])).toEqual([["Found again", true]]);
    expect(result.findings).toEqual([fresh]);
    expect(result.rereview).toMatchObject({ stillOpen: 1 });
  });

  test("reports a carried finding as fixed when the fresh finding it was merged into is refuted", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [finding("Found again")],
      },
      {
        duplicates: [
          {
            id: 2,
            duplicateOf: 1,
          },
        ],
      },
      { verdicts: [verdict(1, "refuted", "The guard was added.")] },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(reviewedBefore([reported("Carried")]), [prompt]);

    expect(result.findings).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.rereview).toMatchObject({
      fixed: [
        {
          finding: finding("Found again"),
          reason: "The guard was added.",
        },
      ],
      stillOpen: 0,
    });
  });

  test("counts a carried finding as still open when the verifier marks it a repeat of a confirmed one", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [finding("Found again")],
      },
      { duplicates: [] },
      {
        verdicts: [
          verdict(1, "confirmed"),
          {
            ...verdict(2, "duplicate"),
            duplicateOf: 1,
          },
        ],
      },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(reviewedBefore([reported("Carried")]), [prompt]);

    expect(result.findings).toEqual([finding("Found again")]);
    expect(result.rereview).toMatchObject({
      fixed: [],
      stillOpen: 1,
    });
  });

  test("skips the merge step when a single finder has nothing to compare", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [],
      },
      { verdicts: [verdict(1, "confirmed")] },
    ]);

    await new FindAndVerify(new ReviewPromptBuilder(), agent, silent).run(
      reviewedBefore([reported("Carried")]),
      [prompt],
    );

    expect(agent.runs).toHaveLength(2);
  });

  test("reports a settled finding apart from the findings and the dropped", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [finding("Declined before"), finding("New")],
      },
      {
        verdicts: [
          verdict(1, "settled", "Declined in round 1 as a deliberate choice."),
          verdict(2, "confirmed"),
        ],
      },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(reviewedBefore([]), [prompt]);

    expect(result.findings).toEqual([finding("New")]);
    expect(result.dropped).toEqual([]);
    expect(result.rereview?.settled).toEqual([
      {
        finding: finding("Declined before"),
        reason: "Declined in round 1 as a deliberate choice.",
      },
    ]);
  });

  test("treats a settled verdict as a refutation on a first review", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [finding("A")],
      },
      { verdicts: [verdict(1, "settled", "Seen before.")] },
    ]);

    const result = await new FindAndVerify(
      new ReviewPromptBuilder(),
      agent,
      silent,
    ).run(context, [prompt]);

    expect(result.rereview).toBeUndefined();
    expect(result.dropped).toEqual([
      {
        finding: finding("A"),
        reason: "Seen before.",
      },
    ]);
  });
});
