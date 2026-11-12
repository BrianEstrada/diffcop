import { describe, expect, test } from "bun:test";
import {
  holdsReview,
  ledgerFromComments,
  ledgerMarker,
  readLedger,
} from "@/reporter/github/ledger-marker";
import { savedReviewMarker } from "@/reporter/github/saved-review-marker";
import type { LedgerEntry, ReviewLedger } from "@/review/review-ledger";
import type { SavedReview } from "@/review/saved-review";

function entry(title: string, explanation: string): LedgerEntry {
  return {
    file: "a.ts",
    startLine: 1,
    endLine: 1,
    severity: "high",
    scope: "introduced",
    title: title,
    explanation: explanation,
    status: "dropped",
    reason: "Guarded by the caller.",
  };
}

const ledger: ReviewLedger = {
  version: 1,
  rounds: [
    {
      headSha: "aaaaaaa",
      entries: [entry("A", "Throws on [] --> crash.")],
    },
    {
      headSha: "bbbbbbb",
      entries: [entry("B", "Loops forever.")],
    },
  ],
};

const ROOMY = 10_000;

describe("ledgerMarker", () => {
  test("round-trips a ledger through an HTML comment", () => {
    const marker = ledgerMarker(ledger, [], ROOMY) ?? "";

    expect(marker).toMatch(/^<!-- diffcop:ledger=[A-Za-z0-9+/=]+ -->$/);
    expect(readLedger(`## diffcop review\n\n${marker}`)).toEqual(ledger);
  });

  test("packs repetitive text well below its size", () => {
    const big: ReviewLedger = {
      version: 1,
      rounds: [
        {
          headSha: "aaaaaaa",
          entries: Array.from({ length: 50 }, (_, index) => {
            return entry(
              `Finding ${index}`,
              "The same explanation. ".repeat(10),
            );
          }),
        },
      ],
    };

    expect((ledgerMarker(big, [], 100_000) ?? "").length).toBeLessThan(
      JSON.stringify(big).length / 4,
    );
  });

  test("redacts secrets, including ones JSON escapes", () => {
    const leaky: ReviewLedger = {
      version: 1,
      rounds: [
        {
          headSha: "aaaaaaa",
          entries: [entry("A", 'Key sk-123 and pa"ss in the env.')],
        },
      ],
    };

    const read = readLedger(
      ledgerMarker(leaky, ["sk-123", 'pa"ss'], ROOMY) ?? "",
    );

    expect(read?.rounds[0]?.entries[0]?.explanation).toBe(
      "Key *** and *** in the env.",
    );
  });

  test("trims the ledger until it fits", () => {
    const whole = (ledgerMarker(ledger, [], ROOMY) ?? "").length;
    const read = readLedger(ledgerMarker(ledger, [], whole - 1) ?? "");

    expect(read?.rounds.at(-1)?.headSha).toBe("bbbbbbb");
    expect(read).not.toEqual(ledger);
  });

  test("is undefined when no round fits", () => {
    expect(ledgerMarker(ledger, [], 10)).toBeUndefined();
  });

  test("is undefined for a ledger without rounds", () => {
    expect(
      ledgerMarker(
        {
          version: 1,
          rounds: [],
        },
        [],
        ROOMY,
      ),
    ).toBeUndefined();
  });
});

describe("readLedger", () => {
  test("reads the marker at the end, past one quoted in the review's text", () => {
    const quoted = "A finding that quotes `<!-- diffcop:ledger=AAAA -->`.";

    expect(
      readLedger(`${quoted}\n${ledgerMarker(ledger, [], ROOMY) ?? ""}`),
    ).toEqual(ledger);
  });

  test.each([
    ["a comment without one", "## diffcop review"],
    ["text that isn't gzip", "<!-- diffcop:ledger=AAAA -->"],
    [
      "gzip that isn't a ledger",
      `<!-- diffcop:ledger=${Buffer.from(Bun.gzipSync(Buffer.from('{"version":2}'))).toString("base64")} -->`,
    ],
  ])("is undefined for %s", (_, body) => {
    expect(readLedger(body)).toBeUndefined();
  });
});

function savedReview(headSha: string, title: string): SavedReview {
  return {
    version: 1,
    headSha: headSha,
    warnings: [],
    result: {
      summary: "",
      findings: [
        {
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          severity: "high",
          scope: "introduced",
          title: title,
          explanation: "Why.",
        },
        {
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          severity: "low",
          scope: "description",
          title: "Claims a cache",
          explanation: "No cache.",
        },
      ],
      dropped: [],
      explored: {
        filesRead: [],
        searches: [],
      },
      stats: {
        durationMs: 1_000,
        toolCalls: 1,
      },
    },
  };
}

function reviewComment(headSha: string, title: string) {
  return `## diffcop review\n\n${savedReviewMarker(savedReview(headSha, title), [])}`;
}

function titles(found: ReviewLedger | undefined) {
  return (found?.rounds ?? []).map(({ headSha, entries }) => {
    const names = entries.map(({ title }) => {
      return title;
    });
    return `${headSha}: ${names.join(", ")}`;
  });
}

describe("ledgerFromComments", () => {
  test("takes one round from each comment's saved review, oldest first", () => {
    const found = ledgerFromComments([
      reviewComment("aaaaaaa", "First"),
      reviewComment("bbbbbbb", "Second"),
    ]);

    expect(titles(found)).toEqual(["aaaaaaa: First", "bbbbbbb: Second"]);
    expect(found?.rounds[0]?.entries[0]).toMatchObject({
      status: "reported",
      explanation: "Why.",
    });
  });

  test("is undefined on a PR diffcop hasn't reviewed", () => {
    expect(ledgerFromComments([])).toBeUndefined();
    expect(ledgerFromComments(["## diffcop review\n\n❌ failed"])).toBe(
      undefined,
    );
  });

  test("skips a comment that holds no review, such as a failure", () => {
    const found = ledgerFromComments([
      reviewComment("aaaaaaa", "First"),
      "## diffcop review\n\n❌ The review of `bbbbbbb` failed.",
    ]);

    expect(titles(found)).toEqual(["aaaaaaa: First"]);
  });

  test("a later comment's round of a commit replaces an earlier one's, and counts as the latest", () => {
    const found = ledgerFromComments([
      reviewComment("aaaaaaa", "First try"),
      reviewComment("bbbbbbb", "Second"),
      reviewComment("aaaaaaa", "Reviewed again"),
    ]);

    expect(titles(found)).toEqual([
      "bbbbbbb: Second",
      "aaaaaaa: Reviewed again",
    ]);
  });

  test("reads every round out of a comment from when diffcop kept one comment", () => {
    const marker = ledgerMarker(ledger, [], ROOMY) ?? "";
    const legacy = `## diffcop review\n${marker}\n${savedReviewMarker(savedReview("bbbbbbb", "Ignored"), [])}`;

    const found = ledgerFromComments([
      legacy,
      reviewComment("ccccccc", "Third"),
    ]);

    expect(titles(found)).toEqual([
      "aaaaaaa: A",
      "bbbbbbb: B",
      "ccccccc: Third",
    ]);
  });

  test("reads the round out of a comment whose review was too long to save", () => {
    const roundOnly = ledgerMarker(
      {
        version: 1,
        rounds: [
          {
            headSha: "ccccccc",
            entries: [entry("C", "Too long.")],
          },
        ],
      },
      [],
      ROOMY,
    );

    const found = ledgerFromComments([
      reviewComment("aaaaaaa", "First"),
      `## diffcop review\n${roundOnly}`,
    ]);

    expect(titles(found)).toEqual(["aaaaaaa: First", "ccccccc: C"]);
  });
});

describe("holdsReview", () => {
  test("is true for a comment with a saved review or a round", () => {
    expect(holdsReview(reviewComment("aaaaaaa", "First"))).toBe(true);
    expect(holdsReview(`x\n${ledgerMarker(ledger, [], ROOMY)}`)).toBe(true);
  });

  test("is false for a failure", () => {
    expect(holdsReview("## diffcop review\n\n❌ failed")).toBe(false);
  });
});
