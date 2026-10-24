import type { RunStats } from "@/agent/reviewer-agent";
import type { SavedReviewStore } from "@/review/description-rechecker";
import type { SavedReview } from "@/review/saved-review";
import type { ReviewCommentFormatter } from "@/reporter/github/review-comment-formatter";
import { readSavedReview } from "@/reporter/github/saved-review-marker";
import type { StickyComment } from "@/reporter/github/sticky-comment";

// Keeps the saved review in the sticky comment it renders.
export class SavedReviewComment implements SavedReviewStore {
  readonly #comment: Pick<StickyComment, "read" | "rewrite">;
  readonly #formatter: ReviewCommentFormatter;

  constructor(
    comment: Pick<StickyComment, "read" | "rewrite">,
    formatter: ReviewCommentFormatter,
  ) {
    this.#comment = comment;
    this.#formatter = formatter;
  }

  async load() {
    const body = await this.#comment.read();
    return body === undefined ? undefined : readSavedReview(body);
  }

  // A running, failed or newer review leaves no saved review to update, so it's left as is.
  async save(
    update: (current: SavedReview) => SavedReview | undefined,
    recheck: RunStats,
  ) {
    return this.#comment.rewrite((body) => {
      const current = readSavedReview(body);
      const updated = current && update(current);
      if (!updated) {
        return undefined;
      }
      return this.#formatter.savedReview(updated, { recheck: recheck });
    });
  }
}
