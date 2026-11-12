import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  findingsSchema,
  numberFindings,
  preferFresh,
  removeDuplicates,
  splitByVerdict,
  verdictsSchema,
} from "@/review/findings";
import type { Finding } from "@/review/findings";

function finding(title: string): Finding {
  return {
    file: "src/a.ts",
    startLine: 10,
    endLine: 12,
    severity: "high",
    scope: "introduced",
    title: title,
    explanation: "Throws when the list is empty.",
  };
}

describe("findingsSchema", () => {
  test("accepts findings and an empty review", () => {
    expect(
      findingsSchema.parse({
        summary: "",
        findings: [finding("A")],
      }),
    ).toEqual({
      summary: "",
      findings: [finding("A")],
    });
    expect(
      findingsSchema.parse({
        summary: "",
        findings: [],
      }),
    ).toEqual({
      summary: "",
      findings: [],
    });
  });

  test("accepts a nit", () => {
    const nit: Finding = {
      ...finding("A"),
      severity: "nit",
    };
    expect(
      findingsSchema.parse({
        summary: "",
        findings: [nit],
      }).findings,
    ).toEqual([nit]);
  });

  test("rejects an unknown severity or a non-integer line", () => {
    expect(
      findingsSchema.safeParse({
        summary: "",
        findings: [
          {
            ...finding("A"),
            severity: "critical",
            scope: "introduced",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      findingsSchema.safeParse({
        summary: "",
        findings: [
          {
            ...finding("A"),
            startLine: 1.5,
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("converts to a JSON schema the model can answer to", () => {
    const schema = z.toJSONSchema(findingsSchema);
    expect(schema).toMatchObject({
      type: "object",
      required: ["summary", "findings"],
    });
    expect(JSON.stringify(schema)).toContain(
      "which input or state fails and why",
    );
    expect(JSON.stringify(schema)).toContain(
      "preexisting: it was already wrong before this diff",
    );
    expect(JSON.stringify(schema)).toContain(
      "never anything a formatter or linter enforces",
    );
  });
});

describe("verdictsSchema", () => {
  test("rejects a verdict other than confirmed or refuted", () => {
    expect(
      verdictsSchema.safeParse({
        verdicts: [
          {
            id: 1,
            verdict: "unsure",
            reason: "",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("numberFindings", () => {
  test("numbers findings from 1", () => {
    expect(
      numberFindings([finding("A"), finding("B")]).map(({ id, title }) => {
        return [id, title];
      }),
    ).toEqual([
      [1, "A"],
      [2, "B"],
    ]);
  });
});

describe("splitByVerdict", () => {
  const findings = [finding("A"), finding("B"), finding("C"), finding("D")];

  test("keeps confirmed findings and drops refuted and unanswered ones with a reason", () => {
    expect(
      splitByVerdict(findings, [
        {
          id: 1,
          verdict: "confirmed",
          reason: "Fails on [].",
        },
        {
          id: 2,
          verdict: "refuted",
          reason: "Guarded by the caller.",
        },
        {
          id: 4,
          verdict: "confirmed",
          reason: "Fails on null.",
        },
      ]),
    ).toMatchObject({
      confirmed: [finding("A"), finding("D")],
      dropped: [
        {
          finding: finding("B"),
          reason: "Guarded by the caller.",
        },
        {
          finding: finding("C"),
          reason: "No verdict returned",
        },
      ],
      settled: [],
    });
  });

  test("drops a finding with contradictory verdicts, keeping both reasons", () => {
    expect(
      splitByVerdict(
        [finding("A")],
        [
          {
            id: 1,
            verdict: "confirmed",
            reason: "Fails on [].",
          },
          {
            id: 1,
            verdict: "refuted",
            reason: "Guarded by the caller.",
          },
        ],
      ),
    ).toMatchObject({
      confirmed: [],
      dropped: [
        {
          finding: finding("A"),
          reason:
            "Contradictory verdicts: Fails on []. / Guarded by the caller.",
        },
      ],
      settled: [],
    });
  });

  test("says so when a refutation has no reason", () => {
    expect(
      splitByVerdict(
        [finding("A")],
        [
          {
            id: 1,
            verdict: "refuted",
            reason: " ",
          },
        ],
      ).dropped,
    ).toEqual([
      {
        finding: finding("A"),
        reason: "Refuted without a reason",
      },
    ]);
  });

  test("ignores verdicts for ids that don't exist", () => {
    expect(
      splitByVerdict(
        [finding("A")],
        [
          {
            id: 0,
            verdict: "confirmed",
            reason: "",
          },
          {
            id: 2,
            verdict: "confirmed",
            reason: "",
          },
        ],
      ),
    ).toMatchObject({
      confirmed: [],
      dropped: [
        {
          finding: finding("A"),
          reason: "No verdict returned",
        },
      ],
      settled: [],
    });
  });

  test("leaves out a duplicate, its original standing for it", () => {
    expect(
      splitByVerdict(
        [finding("A"), finding("A again")],
        [
          {
            id: 1,
            verdict: "confirmed",
            reason: "Fails on [].",
          },
          {
            id: 2,
            verdict: "duplicate",
            duplicateOf: 1,
            reason: "Same as 1.",
          },
        ],
      ),
    ).toMatchObject({
      confirmed: [finding("A")],
      dropped: [],
      settled: [],
    });
  });

  test("reports findings marked duplicates of each other as dropped", () => {
    expect(
      splitByVerdict(
        [finding("A"), finding("B")],
        [
          {
            id: 1,
            verdict: "duplicate",
            duplicateOf: 2,
            reason: "",
          },
          {
            id: 2,
            verdict: "duplicate",
            duplicateOf: 1,
            reason: "",
          },
        ],
      ).dropped,
    ).toEqual([
      {
        finding: finding("A"),
        reason: "Marked a duplicate of another duplicate",
      },
      {
        finding: finding("B"),
        reason: "Marked a duplicate of another duplicate",
      },
    ]);
  });

  test("treats a duplicate of itself or of no finding as unconfirmed", () => {
    expect(
      splitByVerdict(
        [finding("A"), finding("B")],
        [
          {
            id: 1,
            verdict: "duplicate",
            duplicateOf: 1,
            reason: "Same.",
          },
          {
            id: 2,
            verdict: "duplicate",
            reason: "Same.",
          },
        ],
      ),
    ).toMatchObject({
      confirmed: [],
      dropped: [
        {
          finding: finding("A"),
          reason: "Same.",
        },
        {
          finding: finding("B"),
          reason: "Same.",
        },
      ],
      settled: [],
    });
  });
});

describe("removeDuplicates", () => {
  const findings = [finding("A"), finding("B"), finding("C")];

  test("merges each finding named a duplicate into the one it repeats", () => {
    expect(
      removeDuplicates(findings, [
        {
          id: 3,
          duplicateOf: 1,
        },
      ]),
    ).toEqual({
      kept: [finding("A"), finding("B")],
      merged: [
        {
          finding: finding("C"),
          into: finding("A"),
        },
      ],
    });
  });

  test("keeps one of two findings named duplicates of each other", () => {
    expect(
      removeDuplicates(findings, [
        {
          id: 1,
          duplicateOf: 2,
        },
        {
          id: 2,
          duplicateOf: 1,
        },
      ]).kept,
    ).toEqual([finding("B"), finding("C")]);
  });

  test("keeps a finding another one was already merged into", () => {
    expect(
      removeDuplicates(findings, [
        {
          id: 3,
          duplicateOf: 1,
        },
        {
          id: 1,
          duplicateOf: 2,
        },
      ]),
    ).toEqual({
      kept: [finding("A"), finding("B")],
      merged: [
        {
          finding: finding("C"),
          into: finding("A"),
        },
      ],
    });
  });

  test("ignores a duplicate of itself or of a finding that doesn't exist", () => {
    expect(
      removeDuplicates(findings, [
        {
          id: 1,
          duplicateOf: 1,
        },
        {
          id: 2,
          duplicateOf: 4,
        },
        {
          id: 0,
          duplicateOf: 3,
        },
      ]),
    ).toEqual({
      kept: findings,
      merged: [],
    });
  });
});

describe("splitByVerdict on a re-review", () => {
  test("sets a settled finding apart from the confirmed and the dropped", () => {
    expect(
      splitByVerdict(
        [finding("A"), finding("B")],
        [
          {
            id: 1,
            verdict: "settled",
            reason: "Declined in round 2.",
          },
          {
            id: 2,
            verdict: "confirmed",
            reason: "Fails on [].",
          },
        ],
      ),
    ).toMatchObject({
      confirmed: [finding("B")],
      dropped: [],
      settled: [
        {
          finding: finding("A"),
          reason: "Declined in round 2.",
        },
      ],
    });
  });

  test("gives a settled finding without a reason a default one", () => {
    expect(
      splitByVerdict(
        [finding("A")],
        [
          {
            id: 1,
            verdict: "settled",
            reason: " ",
          },
        ],
      ).settled,
    ).toEqual([
      {
        finding: finding("A"),
        reason: "Settled in an earlier round",
      },
    ]);
  });

  test("moves a confirmed finding to the lines the verifier gives", () => {
    expect(
      splitByVerdict(
        [finding("A"), finding("B")],
        [
          {
            id: 1,
            verdict: "confirmed",
            startLine: 40,
            endLine: 44,
            reason: "Still there, further down.",
          },
          {
            id: 2,
            verdict: "confirmed",
            startLine: 7,
            reason: "Still there.",
          },
        ],
      ).confirmed,
    ).toEqual([
      {
        ...finding("A"),
        startLine: 40,
        endLine: 44,
      },
      {
        ...finding("B"),
        startLine: 7,
        endLine: 7,
      },
    ]);
  });

  test("keeps a finding's lines when the verifier's range ends before it starts", () => {
    expect(
      splitByVerdict(
        [finding("A")],
        [
          {
            id: 1,
            verdict: "confirmed",
            startLine: 40,
            endLine: 4,
            reason: "Still there.",
          },
        ],
      ).confirmed,
    ).toEqual([finding("A")]);
  });
});

describe("numberFindings on a re-review", () => {
  test("marks only the findings carried from an earlier round", () => {
    const carried = finding("A");
    const fresh = finding("B");

    expect(numberFindings([carried, fresh], new Set([carried]))).toEqual([
      {
        id: 1,
        ...carried,
        earlierRound: true,
      },
      {
        id: 2,
        ...fresh,
      },
    ]);
  });
});

describe("preferFresh", () => {
  const carried = finding("Carried");
  const fresh = finding("Fresh");
  const other = finding("Other");

  test("keeps the fresh finding when it was merged into a carried one", () => {
    expect(
      preferFresh(
        {
          kept: [carried, other],
          merged: [
            {
              finding: fresh,
              into: carried,
            },
          ],
        },
        new Set([carried]),
      ),
    ).toEqual({
      kept: [fresh, other],
      merged: [
        {
          finding: carried,
          into: fresh,
        },
      ],
    });
  });

  test("points every other duplicate of the carried finding at the fresh one", () => {
    expect(
      preferFresh(
        {
          kept: [carried],
          merged: [
            {
              finding: fresh,
              into: carried,
            },
            {
              finding: other,
              into: carried,
            },
          ],
        },
        new Set([carried]),
      ),
    ).toEqual({
      kept: [fresh],
      merged: [
        {
          finding: carried,
          into: fresh,
        },
        {
          finding: other,
          into: fresh,
        },
      ],
    });
  });

  test("leaves merges between fresh findings, or into a fresh one, as they are", () => {
    const deduped = {
      kept: [fresh],
      merged: [
        {
          finding: other,
          into: fresh,
        },
        {
          finding: carried,
          into: fresh,
        },
      ],
    };

    expect(preferFresh(deduped, new Set([carried]))).toEqual(deduped);
  });
});

describe("splitByVerdict, for findings checked again", () => {
  const still = finding("A");
  const gone = finding("B");
  const split = splitByVerdict(
    [still, gone, finding("C"), finding("D")],
    [
      {
        id: 1,
        verdict: "confirmed",
        reason: "Still there.",
        startLine: 40,
        endLine: 42,
      },
      {
        id: 2,
        verdict: "refuted",
        reason: "The guard was added.",
      },
      {
        id: 3,
        verdict: "refuted",
        reason: "Gone.",
      },
      {
        id: 3,
        verdict: "confirmed",
        reason: "Still there.",
      },
    ],
  );

  test("keeps the finding as given beside the one with the verifier's lines", () => {
    expect(split.confirmed).toEqual([
      {
        ...finding("A"),
        startLine: 40,
        endLine: 42,
      },
    ]);
    expect(split.confirmedFrom[0]).toBe(still);
    expect(split.confirmedFrom).toHaveLength(1);
  });

  test("tells a refuted finding from one without a clear verdict", () => {
    expect(split.refuted.has(gone)).toBe(true);
    expect(split.refuted.size).toBe(1);
    expect(
      split.dropped.map(({ finding: dropped }) => {
        return dropped.title;
      }),
    ).toEqual(["B", "C", "D"]);
  });
});
