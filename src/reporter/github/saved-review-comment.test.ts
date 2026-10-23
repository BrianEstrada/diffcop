import { describe, expect, test } from "bun:test";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import { ReviewCommentFormatter } from "@/reporter/github/review-comment-formatter";
import { SavedReviewComment } from "@/reporter/github/saved-review-comment";
import { readSavedReview } from "@/reporter/github/saved-review-marker";
import type { SavedReview } from "@/review/saved-review";

const pr: PullRequestContext = {
  apiUrl: "https://api.github.test",
  repo: "owner/repo",
  number: 7,
  headSha: "abc1234def",
  title: "Title",
  body: "",
  triggerTime: "2026-10-02T10:00:00Z",
};

const formatter = new ReviewCommentFormatter(pr);

const reviewed = formatter.review({
  summary: "",
  findings: [
    {
      file: "a.ts",
      startLine: 1,
      endLine: 1,
      severity: "low",
      scope: "description",
      title: "Claims a cache the diff doesn't add",
      explanation: "No cache.",
    },
  ],
  dropped: [],
  explored: {
    filesRead: [],
    searches: [],
  },
  stats: {
    durationMs: 60_000,
    toolCalls: 20,
  },
});

class FakeComment {
  body: string | undefined;

  constructor(body: string | undefined) {
    this.body = body;
  }

  async read() {
    return this.body;
  }

  async rewrite(update: (body: string) => string | undefined) {
    const updated = this.body === undefined ? undefined : update(this.body);
    if (updated === undefined) {
      return false;
    }
    this.body = updated;
    return true;
  }
}

describe("SavedReviewComment", () => {
  test("loads the review the comment saved", async () => {
    const store = new SavedReviewComment(new FakeComment(reviewed), formatter);
    expect(await store.load()).toEqual(readSavedReview(reviewed));
  });

  test("loads nothing from a comment showing a running review", async () => {
    const store = new SavedReviewComment(
      new FakeComment(formatter.running()),
      formatter,
    );
    expect(await store.load()).toBeUndefined();
  });

  test("renders the updated review with the re-check's stats", async () => {
    const comment = new FakeComment(reviewed);
    const store = new SavedReviewComment(comment, formatter);

    const written = await store.save(
      (current) => {
        return {
          ...current,
          result: {
            ...current.result,
            findings: [],
          },
        };
      },
      {
        durationMs: 5_000,
        toolCalls: 2,
      },
    );

    expect(written).toBe(true);
    expect(comment.body).toContain("✅ **All good**");
    expect(comment.body).toContain(
      "description re-checked in 5s · 2 tool calls",
    );
    expect(readSavedReview(comment.body ?? "")?.result.findings).toEqual([]);
  });

  test("leaves a comment alone once a newer review is running", async () => {
    const running = formatter.running();
    const comment = new FakeComment(running);
    const updates: SavedReview[] = [];

    const written = await new SavedReviewComment(comment, formatter).save(
      (current) => {
        updates.push(current);
        return current;
      },
      {
        durationMs: 5_000,
        toolCalls: 2,
      },
    );

    expect(written).toBe(false);
    expect(updates).toEqual([]);
    expect(comment.body).toBe(running);
  });
});
