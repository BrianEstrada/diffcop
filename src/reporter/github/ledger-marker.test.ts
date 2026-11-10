import { describe, expect, test } from "bun:test";
import { ledgerMarker, readLedger } from "@/reporter/github/ledger-marker";
import type { LedgerEntry, ReviewLedger } from "@/review/review-ledger";

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
