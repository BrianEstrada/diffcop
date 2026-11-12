import { describe, expect, test } from "bun:test";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import { readLedger } from "@/reporter/github/ledger-marker";
import { ReviewCommentFormatter } from "@/reporter/github/review-comment-formatter";
import { SavedReviewComment } from "@/reporter/github/saved-review-comment";
import { readSavedReview } from "@/reporter/github/saved-review-marker";
import type { StatusUpdate } from "@/reporter/github/commit-status";
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

const COMMENT_URL = "https://github.test/owner/repo/pull/7#issuecomment-500";

class FakeStatus {
  updates: StatusUpdate[] = [];

  async post(update: StatusUpdate) {
    this.updates.push(update);
  }
}

class FakeComment {
  body: string | undefined;
  url = COMMENT_URL;

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
    const store = new SavedReviewComment(
      new FakeComment(reviewed),
      formatter,
      new FakeStatus(),
    );
    expect(await store.load()).toEqual(readSavedReview(reviewed));
  });

  test("loads nothing from a comment showing a running review", async () => {
    const store = new SavedReviewComment(
      new FakeComment(formatter.running()),
      formatter,
      new FakeStatus(),
    );
    expect(await store.load()).toBeUndefined();
  });

  test("renders the updated review with the re-check's stats", async () => {
    const comment = new FakeComment(reviewed);
    const status = new FakeStatus();
    const store = new SavedReviewComment(comment, formatter, status);

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
      "| Description re-check | 5s | 2 | – | – | – | – |",
    );
    expect(readSavedReview(comment.body ?? "")?.result.findings).toEqual([]);
    expect(status.updates).toEqual([
      {
        state: "success",
        description: "All good",
        url: COMMENT_URL,
      },
    ]);
  });

  test("keeps the status failing while the description still doesn't match", async () => {
    const status = new FakeStatus();
    const store = new SavedReviewComment(
      new FakeComment(reviewed),
      formatter,
      status,
    );

    await store.save(
      (current) => {
        return current;
      },
      {
        durationMs: 5_000,
        toolCalls: 2,
      },
    );

    expect(status.updates).toMatchObject([
      {
        state: "failure",
        description: "Description doesn't match the diff",
      },
    ]);
  });

  test("keeps the comment's ledger when it rewrites the review", async () => {
    const comment = new FakeComment(reviewed);
    const ledger = readLedger(reviewed);

    await new SavedReviewComment(comment, formatter, new FakeStatus()).save(
      (current) => {
        return current;
      },
      {
        durationMs: 5_000,
        toolCalls: 2,
      },
    );

    expect(ledger?.rounds).toHaveLength(1);
    expect(readLedger(comment.body ?? "")).toEqual(ledger);
  });

  test("leaves a comment alone once a newer review is running", async () => {
    const running = formatter.running();
    const comment = new FakeComment(running);
    const updates: SavedReview[] = [];
    const status = new FakeStatus();

    const written = await new SavedReviewComment(
      comment,
      formatter,
      status,
    ).save(
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
    expect(status.updates).toEqual([]);
  });
});
