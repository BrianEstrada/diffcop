import { describe, expect, test } from "bun:test";
import type { RunStats } from "@/agent/reviewer-agent";
import { runDetailsSection } from "@/reporter/run-details";
import type { FinderSummary } from "@/review/saved-review";

const stats: RunStats = {
  durationMs: 165_000,
  toolCalls: 39,
  inputTokens: 3_100_000,
  cacheReadTokens: 2_945_000,
  outputTokens: 13_900,
  costUsd: 1.78,
};

const RUNS_HEADER = [
  "| Run | Time | Tool calls | Input tokens | Cached | Output | Cost |",
  "| --- | --- | --- | --- | --- | --- | --- |",
].join("\n");

function finder(
  chunk: number | undefined,
  overrides: Partial<FinderSummary> = {},
): FinderSummary {
  return {
    ...(chunk !== undefined && {
      chunk: chunk,
      files: 3,
      lines: 400 + chunk,
    }),
    findings: 1,
    stats: {
      durationMs: 80_000,
      toolCalls: 12,
      costUsd: 0.4,
    },
    ...overrides,
  };
}

// Pass 1 of each chunk, then pass 2, then the whole diff: the order the finders run in.
const finders = [finder(1), finder(2), finder(1), finder(2), finder(undefined)];

describe("runDetailsSection", () => {
  test("is a closed section", () => {
    const section = runDetailsSection({ stats: stats });

    expect(section.title).toBe("Run details");
    expect(section.open).toBe(false);
  });

  test("lists the review's numbers in one row, and says one finder reviewed the diff", () => {
    expect(runDetailsSection({ stats: stats }).body).toBe(
      [
        RUNS_HEADER,
        "| Review | 2m 45s | 39 | 3.1M | 95% | 13.9K | ~$1.78 |",
        "",
        "One finder reviewed the whole diff.",
      ].join("\n"),
    );
  });

  test("gives the description re-check a row of its own", () => {
    const { body } = runDetailsSection({
      stats: stats,
      recheck: {
        durationMs: 25_000,
        toolCalls: 1,
        inputTokens: 160_900,
        cacheReadTokens: 112_630,
        outputTokens: 2_000,
        costUsd: 0.34,
      },
    });

    expect(body).toStartWith(
      [
        RUNS_HEADER,
        "| Review | 2m 45s | 39 | 3.1M | 95% | 13.9K | ~$1.78 |",
        "| Description re-check | 25s | 1 | 160.9K | 70% | 2K | ~$0.34 |",
      ].join("\n"),
    );
  });

  test("marks the numbers a run didn't report", () => {
    const { body } = runDetailsSection({
      stats: {
        durationMs: 5_000,
        toolCalls: 1,
        inputTokens: 0,
      },
    });

    expect(body).toContain("| Review | 5s | 1 | 0 | – | – | – |");
  });

  test("lists each chunk's finders together, with the chunk's size, and the whole-diff finder last", () => {
    const { body } = runDetailsSection({
      stats: stats,
      finders: finders,
      merged: 0,
    });

    expect(body).toEndWith(
      [
        "The diff was split into 2 chunks, each reviewed by 2 finders, and one more finder reviewed the whole diff.",
        "",
        "| Finder | Files | Changed lines | Findings | Time | Tool calls | Cost |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| Chunk 1 | 3 | 401 | 1 | 1m 20s | 12 | ~$0.40 |",
        "| Chunk 1, pass 2 | 3 | 401 | 1 | 1m 20s | 12 | ~$0.40 |",
        "| Chunk 2 | 3 | 402 | 1 | 1m 20s | 12 | ~$0.40 |",
        "| Chunk 2, pass 2 | 3 | 402 | 1 | 1m 20s | 12 | ~$0.40 |",
        "| Whole diff | – | – | 1 | 1m 20s | 12 | ~$0.40 |",
      ].join("\n"),
    );
    expect(body).not.toContain("One finder reviewed the whole diff.");
  });

  test("says what was split on a re-review, and how many duplicates were merged", () => {
    const { body } = runDetailsSection({
      stats: stats,
      finders: [finder(1), finder(1), finder(undefined)],
      merged: 1,
      since: "fe572a3d00",
    });

    expect(body).toContain(
      "What changed since `fe572a3` was split into 1 chunk, each reviewed by 2 finders, and one more finder reviewed the whole diff. 1 duplicate finding was merged before verification.",
    );
    expect(
      runDetailsSection({
        stats: stats,
        finders: finders,
        merged: 3,
      }).body,
    ).toContain("3 duplicate findings were merged before verification.");
  });

  test("adds a column for the error's first line only when a finder failed", () => {
    const { body } = runDetailsSection({
      stats: stats,
      finders: [
        finder(1),
        finder(1, {
          findings: 0,
          stats: undefined,
          error: "never submitted | exit 1\n  at bootstrap",
        }),
        finder(undefined),
      ],
    });

    expect(body).toContain(
      [
        "| Finder | Files | Changed lines | Findings | Time | Tool calls | Cost | Failed |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| Chunk 1 | 3 | 401 | 1 | 1m 20s | 12 | ~$0.40 |  |",
        "| Chunk 1, pass 2 | 3 | 401 | 0 | – | – | – | never submitted \\| exit 1 |",
      ].join("\n"),
    );
  });
});
