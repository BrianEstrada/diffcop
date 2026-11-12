import { describe, expect, test } from "bun:test";
import {
  readSavedReview,
  savedReviewMarker,
} from "@/reporter/github/saved-review-marker";
import type { SavedReview } from "@/review/saved-review";

const saved: SavedReview = {
  version: 1,
  headSha: "abc1234def",
  warnings: [],
  result: {
    summary: "Read the parser.",
    findings: [
      {
        file: "a.ts",
        startLine: 1,
        endLine: 1,
        severity: "high",
        scope: "introduced",
        title: "Ends the comment early",
        explanation: "The text holds --> and a token sk-123.",
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

describe("savedReviewMarker", () => {
  test("round-trips a review through an HTML comment", () => {
    const marker = savedReviewMarker(saved, []);

    expect(marker).toMatch(/^<!-- diffcop:saved=[A-Za-z0-9+/=]+ -->$/);
    expect(readSavedReview(`## diffcop review\n${marker}`)).toEqual(saved);
  });

  test("packs repetitive text well below its size", () => {
    const long: SavedReview = {
      ...saved,
      result: {
        ...saved.result,
        summary: "The same sentence again. ".repeat(2_000),
      },
    };

    expect(savedReviewMarker(long, []).length).toBeLessThan(
      JSON.stringify(long).length / 4,
    );
  });

  test("redacts secrets", () => {
    const marker = savedReviewMarker(saved, ["sk-123"]);

    expect(readSavedReview(marker)?.result.findings[0]?.explanation).toBe(
      "The text holds --> and a token ***.",
    );
  });
});

describe("readSavedReview", () => {
  test("reads a marker written before they were gzipped", () => {
    const plain = Buffer.from(JSON.stringify(saved)).toString("base64");

    expect(readSavedReview(`<!-- diffcop:saved=${plain} -->`)).toEqual(saved);
  });

  test("reads the marker at the end, past one quoted in the review's text", () => {
    const quoted = savedReviewMarker(
      {
        ...saved,
        headSha: "0000000",
      },
      [],
    );

    const body = `Quoting ${quoted} here.\n${savedReviewMarker(saved, [])}`;

    expect(readSavedReview(body)?.headSha).toBe("abc1234def");
  });

  test("is undefined for a comment without one, or one it can't read", () => {
    expect(readSavedReview("## diffcop review")).toBeUndefined();
    expect(readSavedReview("<!-- diffcop:saved=AAAA -->")).toBeUndefined();
    expect(readSavedReview("<!-- diffcop:saved=H4sIAAAA -->")).toBeUndefined();
  });
});
