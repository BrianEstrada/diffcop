import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "@/context/repository";
import {
  ChangeSizeLimit,
  measureChangeSize,
  staleBaseWarning,
} from "@/review/change-size-limit";

function file(path: string, additions: number, deletions = 0): ChangedFile {
  return {
    path: path,
    additions: additions,
    deletions: deletions,
  };
}

describe("measureChangeSize", () => {
  test("adds up additions and deletions across files", () => {
    expect(measureChangeSize([file("a.ts", 10, 5), file("b.ts", 3)])).toEqual({
      lines: 18,
      files: 2,
    });
  });

  test.each([
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "packages/web/yarn.lock",
  ])("leaves out the lockfile %p", (path) => {
    expect(measureChangeSize([file("a.ts", 1), file(path, 5_000)])).toEqual({
      lines: 1,
      files: 1,
    });
  });

  test("counts a binary file as a file with no lines", () => {
    expect(measureChangeSize([file("logo.png", 0)])).toEqual({
      lines: 0,
      files: 1,
    });
  });
});

describe("ChangeSizeLimit", () => {
  const limit = new ChangeSizeLimit({
    maxLines: 1_000,
    maxFiles: 20,
  });

  function files(n: number, linesEach: number) {
    return Array.from({ length: n }, (_, i) => {
      return file(`f${i}.ts`, linesEach);
    });
  }

  test("says nothing at exactly the limits", () => {
    expect(limit.warning(files(20, 50))).toBeUndefined();
  });

  test("warns when there are too many lines", () => {
    expect(limit.warning([file("a.ts", 1_234)])).toBe(
      "This change is large: 1,234 lines (over the 1,000-line limit) across 1 file, not counting lockfiles. " +
        "Large changes get less accurate reviews; consider splitting it into stacked PRs.",
    );
  });

  test("warns when there are too many files", () => {
    expect(limit.warning(files(21, 1))).toStartWith(
      "This change is large: 21 lines across 21 files (over the 20-file limit),",
    );
  });

  test("names both limits when both are exceeded", () => {
    expect(limit.warning(files(25, 50))).toStartWith(
      "This change is large: 1,250 lines (over the 1,000-line limit) across 25 files (over the 20-file limit),",
    );
  });

  test("ignores a large lockfile", () => {
    expect(limit.warning([file("bun.lock", 50_000)])).toBeUndefined();
  });
});

describe("staleBaseWarning", () => {
  test("warns when the diff has far more files than GitHub lists", () => {
    expect(staleBaseWarning("origin/main", 137, 4)).toBe(
      "The diff against origin/main has 137 files, but GitHub lists 4 files for " +
        "this PR, so its base may have changed after this run started. Re-run " +
        "the review to diff against the current base.",
    );
  });

  test.each([
    ["GitHub doesn't list the files", 137, undefined],
    ["the counts match", 4, 4],
    ["the diff has at most twice as many", 40, 20],
    ["the diff has at most 10 more", 12, 2],
  ])("stays quiet when %s", (_, localFiles, githubFiles) => {
    expect(
      staleBaseWarning("origin/main", localFiles, githubFiles),
    ).toBeUndefined();
  });
});
