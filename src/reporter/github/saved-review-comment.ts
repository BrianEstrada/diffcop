import type { RunStats } from "@/agent/reviewer-agent";
import type { SavedReviewStore } from "@/review/description-rechecker";
import type { SavedReview } from "@/review/saved-review";
import type { ReviewCommentFormatter } from "@/reporter/github/review-comment-formatter";
import { readSavedReview } from "@/reporter/github/saved-review-marker";
import type { ReviewComments } from "@/reporter/github/review-comments";
import { reviewStatus } from "@/reporter/github/commit-status";
import type { CommitStatus } from "@/reporter/github/commit-status";

type Comment = Pick<ReviewComments, "read" | "rewrite" | "url">;

// Keeps the saved review in the comment that renders it: the newest one.
export class SavedReviewComment implements SavedReviewStore {
  readonly #comment: Comment;
  readonly #formatter: ReviewCommentFormatter;
  readonly #status: Pick<CommitStatus, "post">;

  constructor(
    comment: Comment,
    formatter: ReviewCommentFormatter,
    status: Pick<CommitStatus, "post">,
  ) {
    this.#comment = comment;
    this.#formatter = formatter;
    this.#status = status;
  }

  async load() {
    const body = await this.#comment.read();
    return body === undefined ? undefined : readSavedReview(body);
  }

  // A failed review leaves no saved review to update, so it's left as is.
  async save(
    update: (current: SavedReview) => SavedReview | undefined,
    recheck: RunStats,
  ) {
    let rewritten: SavedReview | undefined;
    const written = await this.#comment.rewrite((body) => {
      const current = readSavedReview(body);
      const updated = current && update(current);
      if (!updated) {
        return undefined;
      }
      rewritten = updated;
      return this.#formatter.savedReview(updated, { recheck: recheck });
    });
    // A description finding can be what turned the status red, so it follows the comment.
    if (written && rewritten) {
      await this.#status.post(
        reviewStatus(rewritten.result, this.#comment.url),
      );
    }
    return written;
  }
}
