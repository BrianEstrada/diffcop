import { describe, expect, test } from "bun:test";
import { outstandingWork } from "@/review/outstanding-work";
import type { OutstandingWork, ReviewTrigger } from "@/review/outstanding-work";

const push: ReviewTrigger = {
  headSha: "bbbbbbb1234",
  baseRef: "main",
  edited: false,
  baseChanged: false,
};

const edit: ReviewTrigger = {
  ...push,
  edited: true,
};

const reviewedHead = {
  headSha: "bbbbbbb1234",
  baseRef: "main",
};

const reviewedEarlier = {
  headSha: "aaaaaaa1234",
  baseRef: "main",
};

describe("outstandingWork", () => {
  test("a push reviews the code, whatever was reviewed before", () => {
    for (const last of [undefined, reviewedEarlier, reviewedHead]) {
      expect(outstandingWork(push, last)).toEqual({
        kind: "review",
        full: false,
      });
    }
  });

  test("an edit re-checks the description when the head commit has its review", () => {
    expect(outstandingWork(edit, reviewedHead)).toEqual({ kind: "recheck" });
  });

  test("an edit reviews the code when the head commit has no finished review", () => {
    const expected: OutstandingWork = {
      kind: "review",
      full: false,
      reason: "bbbbbbb has no finished review yet, so reviewing the code.",
    };
    expect(outstandingWork(edit, reviewedEarlier)).toEqual(expected);
    expect(outstandingWork(edit, undefined)).toEqual(expected);
  });

  test("an edit that moves the base reviews the whole change again", () => {
    expect(
      outstandingWork(
        {
          ...edit,
          baseChanged: true,
        },
        reviewedHead,
      ),
    ).toEqual({
      kind: "review",
      full: true,
      reason:
        "The PR's base changed since the last review, so reviewing the whole change again.",
    });
  });

  test("a later run still sees a base that moved, when the run for that edit never finished", () => {
    const retargeted = {
      ...reviewedHead,
      baseRef: "release",
    };
    expect(outstandingWork(edit, retargeted)).toMatchObject({
      kind: "review",
      full: true,
    });
    expect(outstandingWork(push, retargeted)).toEqual({
      kind: "review",
      full: true,
    });
  });

  test("a review saved without its base isn't taken for a moved base", () => {
    expect(outstandingWork(edit, { headSha: "bbbbbbb1234" })).toEqual({
      kind: "recheck",
    });
    expect(
      outstandingWork(
        {
          ...edit,
          baseRef: undefined,
        },
        reviewedHead,
      ),
    ).toEqual({ kind: "recheck" });
  });
});
