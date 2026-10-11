import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  findingsSchema,
  numberFindings,
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
    ).toEqual({
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
    ).toEqual({
      confirmed: [],
      dropped: [
        {
          finding: finding("A"),
          reason:
            "Contradictory verdicts: Fails on []. / Guarded by the caller.",
        },
      ],
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
    ).toEqual({
      confirmed: [],
      dropped: [
        {
          finding: finding("A"),
          reason: "No verdict returned",
        },
      ],
    });
  });
});
