import { describe, expect, test } from "bun:test";
import type { Finding, ReviewResult } from "@/review/findings";
import {
  appendRound,
  carriedFindings,
  earlierRounds,
  fitLedger,
  reviewLedgerSchema,
} from "@/review/review-ledger";
import type {
  LedgerEntry,
  LedgerRound,
  ReviewLedger,
} from "@/review/review-ledger";

function finding(title: string, overrides: Partial<Finding> = {}): Finding {
  return {
    file: "a.ts",
    startLine: 1,
    endLine: 2,
    severity: "high",
    scope: "introduced",
    title: title,
    explanation: `${title} fails on [].`,
    ...overrides,
  };
}

function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: "",
    findings: [],
    dropped: [],
    explored: {
      filesRead: [],
      searches: [],
    },
    stats: {
      durationMs: 1,
      toolCalls: 0,
    },
    ...overrides,
  };
}

function entry(title: string, overrides: Partial<LedgerEntry> = {}) {
  return {
    ...finding(title),
    status: "reported" as const,
    ...overrides,
  };
}

function ledger(...rounds: [string, LedgerEntry[]][]): ReviewLedger {
  return {
    version: 1,
    rounds: rounds.map(([headSha, entries]) => {
      return {
        headSha: headSha,
        entries: entries,
      };
    }),
  };
}

describe("appendRound", () => {
  test("records what the round reported, dropped and settled, with the reasons", () => {
    const appended = appendRound(
      undefined,
      "aaaaaaa",
      result({
        findings: [finding("A")],
        dropped: [
          {
            finding: finding("B"),
            reason: "Guarded by the caller.",
          },
        ],
        rereview: {
          settled: [
            {
              finding: finding("C"),
              reason: "Declined in round 1.",
            },
          ],
          leftOut: 0,
        },
      }),
    );

    expect(appended).toEqual(
      ledger([
        "aaaaaaa",
        [
          entry("A"),
          entry("B", {
            status: "dropped",
            reason: "Guarded by the caller.",
          }),
          entry("C", {
            status: "settled",
            reason: "Declined in round 1.",
          }),
        ],
      ]),
    );
    expect(reviewLedgerSchema.parse(appended)).toEqual(appended);
  });

  test("leaves description findings out", () => {
    const description = finding("Claims a cache", { scope: "description" });
    const appended = appendRound(
      undefined,
      "aaaaaaa",
      result({
        findings: [description],
        dropped: [
          {
            finding: description,
            reason: "The description doesn't say that.",
          },
        ],
      }),
    );

    expect(appended.rounds[0]?.entries).toEqual([]);
  });

  test("adds a round after the earlier ones", () => {
    const appended = appendRound(
      ledger(["aaaaaaa", [entry("A")]]),
      "bbbbbbb",
      result({ findings: [finding("B")] }),
    );

    expect(
      appended.rounds.map(({ headSha }) => {
        return headSha;
      }),
    ).toEqual(["aaaaaaa", "bbbbbbb"]);
  });

  test("redoes the round of a commit reviewed again", () => {
    const appended = appendRound(
      ledger(["aaaaaaa", [entry("A")]], ["bbbbbbb", [entry("B")]]),
      "bbbbbbb",
      result({ findings: [finding("C")] }),
    );

    expect(appended.rounds).toEqual([
      {
        headSha: "aaaaaaa",
        entries: [entry("A")],
      },
      {
        headSha: "bbbbbbb",
        entries: [entry("C")],
        complete: true,
      },
    ]);
  });

  test("records what a re-review found fixed, and that it lists every open finding", () => {
    const appended = appendRound(
      undefined,
      "bbbbbbb",
      result({
        findings: [finding("Still open")],
        rereview: {
          settled: [],
          fixed: [
            {
              finding: finding("Gone"),
              reason: "The guard was added.",
            },
          ],
          stillOpen: 1,
          leftOut: 0,
        },
      }),
    );

    expect(appended.rounds).toEqual([
      {
        headSha: "bbbbbbb",
        entries: [
          entry("Still open"),
          entry("Gone", {
            status: "fixed",
            reason: "The guard was added.",
          }),
        ],
        complete: true,
      },
    ]);
  });

  test("doesn't take a re-review from before open findings were carried over for complete", () => {
    const appended = appendRound(
      undefined,
      "bbbbbbb",
      result({
        rereview: {
          settled: [],
          leftOut: 0,
        },
      }),
    );

    expect(appended.rounds[0]?.complete).toBeUndefined();
  });
});

describe("earlierRounds", () => {
  test("leaves out the round of the commit under review", () => {
    const rounds = earlierRounds(
      ledger(["aaaaaaa", [entry("A")]], ["bbbbbbb", [entry("B")]]),
      "bbbbbbb",
    );

    expect(rounds).toEqual(ledger(["aaaaaaa", [entry("A")]]).rounds);
  });

  test("is empty without a ledger", () => {
    expect(earlierRounds(undefined, "aaaaaaa")).toEqual([]);
  });
});

describe("carriedFindings", () => {
  function titles(rounds: LedgerRound[]) {
    return carriedFindings(rounds).map(({ title }) => {
      return title;
    });
  }

  test("carries every finding the last round left open, whatever its severity", () => {
    const { rounds } = ledger(
      ["aaaaaaa", [entry("Old")]],
      [
        "bbbbbbb",
        [
          entry("High"),
          entry("Medium", { severity: "medium" }),
          entry("Low", { severity: "low" }),
          entry("Nit", { severity: "nit" }),
          entry("Preexisting", { scope: "preexisting" }),
          entry("Dropped", {
            status: "dropped",
            reason: "Guarded.",
          }),
          entry("Settled", {
            status: "settled",
            reason: "Declined.",
          }),
          entry("Fixed", {
            status: "fixed",
            reason: "The guard was added.",
          }),
        ],
      ],
    );
    const complete = rounds.map((round) => {
      return {
        ...round,
        complete: true,
      };
    });

    expect(carriedFindings(complete)).toEqual([
      finding("High"),
      finding("Medium", { severity: "medium" }),
      finding("Low", { severity: "low" }),
      finding("Nit", { severity: "nit" }),
      finding("Preexisting", { scope: "preexisting" }),
    ]);
  });

  test("goes back for the minor findings of rounds that only carried bugs over", () => {
    const { rounds } = ledger(
      [
        "aaaaaaa",
        [
          entry("Bug, fixed since"),
          entry("Nit from round 1", { severity: "nit" }),
          entry("Dropped", {
            status: "dropped",
            reason: "Guarded.",
          }),
        ],
      ],
      [
        "bbbbbbb",
        [
          entry("Bug, still open"),
          entry("Low from round 2", { severity: "low" }),
        ],
      ],
    );

    expect(titles(rounds)).toEqual([
      "Bug, still open",
      "Low from round 2",
      "Nit from round 1",
    ]);
  });

  test("stops at the last round that listed every open finding", () => {
    const rounds: LedgerRound[] = [
      {
        headSha: "aaaaaaa",
        entries: [entry("Nit, fixed since", { severity: "nit" })],
      },
      {
        headSha: "bbbbbbb",
        entries: [entry("Nit, open", { severity: "nit" })],
        complete: true,
      },
      {
        headSha: "ccccccc",
        entries: [entry("Bug")],
      },
    ];

    expect(titles(rounds)).toEqual(["Bug", "Nit, open"]);
  });

  test("leaves out a minor finding that a later round settled, dropped or fixed", () => {
    const { rounds } = ledger(
      [
        "aaaaaaa",
        [
          entry("Declined later", { severity: "nit" }),
          entry("Dropped later", { severity: "nit" }),
          entry("Fixed later", { severity: "low" }),
          entry("Never judged", { severity: "low" }),
        ],
      ],
      [
        "bbbbbbb",
        [
          entry("Declined later", {
            severity: "nit",
            status: "settled",
            reason: "Declined.",
          }),
          entry("Dropped later", {
            severity: "nit",
            status: "dropped",
            reason: "Guarded.",
          }),
          entry("Fixed later", {
            severity: "low",
            status: "fixed",
            reason: "Gone.",
          }),
        ],
      ],
    );

    expect(titles(rounds)).toEqual(["Never judged"]);
  });

  test("carries both of two findings in a round that share a file and a title", () => {
    const { rounds } = ledger([
      "aaaaaaa",
      [
        entry("Missing null check", { startLine: 10 }),
        entry("Missing null check", { startLine: 90 }),
      ],
    ]);

    expect(
      carriedFindings(rounds).map(({ startLine }) => {
        return startLine;
      }),
    ).toEqual([10, 90]);
  });

  test("carries a finding once when two rounds reported it", () => {
    const { rounds } = ledger(
      ["aaaaaaa", [entry("Same", { severity: "nit" })]],
      ["bbbbbbb", [entry("Same", { severity: "nit" })]],
    );

    expect(titles(rounds)).toEqual(["Same"]);
  });

  test("carries a finding whose explanation was trimmed", () => {
    const { explanation: _explanation, ...trimmed } = entry("A");

    expect(carriedFindings(ledger(["aaaaaaa", [trimmed]]).rounds)).toEqual([
      finding("A", { explanation: "" }),
    ]);
  });

  test("carries nothing on a first review", () => {
    expect(carriedFindings([])).toEqual([]);
  });
});

describe("fitLedger", () => {
  const dropped = entry("Dropped", {
    status: "dropped",
    reason: "Guarded.",
  });
  const full = ledger(
    ["aaaaaaa", [entry("A"), dropped]],
    ["bbbbbbb", [entry("B"), dropped]],
  );

  function size(candidate: ReviewLedger) {
    return JSON.stringify(candidate).length;
  }

  // The loosest limit the ledger meets only after `steps` trims.
  function fitAfter(steps: number) {
    let calls = 0;
    return fitLedger(full, () => {
      return calls++ >= steps;
    });
  }

  function withoutExplanation({
    explanation: _explanation,
    ...item
  }: LedgerEntry) {
    return item;
  }

  test("leaves a ledger that fits as it is", () => {
    expect(fitAfter(0)).toBe(full);
  });

  test("trims explanations first, from the oldest round", () => {
    expect(fitAfter(1)).toEqual(
      ledger(
        ["aaaaaaa", [entry("A"), dropped].map(withoutExplanation)],
        ["bbbbbbb", [entry("B"), dropped]],
      ),
    );
  });

  test("then trims reported entries from every round but the last", () => {
    expect(fitAfter(3)).toEqual(
      ledger(
        ["aaaaaaa", [withoutExplanation(dropped)]],
        ["bbbbbbb", [entry("B"), dropped].map(withoutExplanation)],
      ),
    );
  });

  test("then drops whole rounds, oldest first", () => {
    expect(fitAfter(4)).toEqual(
      ledger(["bbbbbbb", [entry("B"), dropped].map(withoutExplanation)]),
    );
  });

  test("keeps nothing when not even the last round fits", () => {
    expect(
      fitLedger(full, () => {
        return false;
      }).rounds,
    ).toEqual([]);
  });

  test("only ever shrinks the ledger", () => {
    const limit = size(full) - 1;
    const fitted = fitLedger(full, (candidate) => {
      return size(candidate) <= limit;
    });

    expect(size(fitted)).toBeLessThanOrEqual(limit);
    expect(fitted.rounds).toHaveLength(2);
  });
});

describe("reviewLedgerSchema", () => {
  test("rejects a round whose commit isn't a hex SHA", () => {
    expect(
      reviewLedgerSchema.safeParse(ledger(["--output=/tmp/x", []])).success,
    ).toBe(false);
  });
});
