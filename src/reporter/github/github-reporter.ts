import { toError } from "@/util/errors";
import type { ReviewResult } from "@/review/findings";
import { thinkingLine, toolCallLine, verifyingLine } from "@/reporter/progress";
import type { ReviewReporter, TextSink } from "@/reporter/review-reporter";
import type { ReviewCommentFormatter } from "@/reporter/github/review-comment-formatter";
import type { StickyComment } from "@/reporter/github/sticky-comment";

export interface GitHubReporterOptions {
  // Also log tool calls and thinking time, to see where a slow run went.
  debug?: boolean;
}

export class GitHubReporter implements ReviewReporter {
  readonly #comment: StickyComment;
  readonly #formatter: ReviewCommentFormatter;
  readonly #log: TextSink;
  readonly #debug: boolean;

  constructor(
    comment: StickyComment,
    formatter: ReviewCommentFormatter,
    log: TextSink,
    { debug = false }: GitHubReporterOptions = {},
  ) {
    this.#comment = comment;
    this.#formatter = formatter;
    this.#log = log;
    this.#debug = debug;
  }

  // Only a status update, so a failure here (e.g. a GitHub API blip) doesn't
  // stop the review; the result is still posted when it's done.
  async started() {
    await this.#post(this.#formatter.running()).catch((cause: unknown) => {
      this.#warn(toError(cause));
    });
  }

  // Re-posts the running status so the warning shows while the review runs.
  async warning(message: string) {
    this.#formatter.addWarning(message);
    await this.started();
  }

  toolCall(toolName: string, input: string) {
    if (this.#debug) {
      this.#log.write(`${toolCallLine(toolName, input)}\n`);
    }
  }

  thinking(durationMs: number) {
    if (this.#debug) {
      this.#log.write(`${thinkingLine(durationMs)}\n`);
    }
  }

  // Logged even without debug: one line that explains a long second wait.
  async verifying(findings: number) {
    this.#log.write(`${verifyingLine(findings)}\n`);
  }

  // Unlike the status updates, a failed post throws: the run should fail, not
  // pass with the comment stuck on "running".
  async completed(result: ReviewResult) {
    await this.#post(this.#formatter.review(result));
  }

  async failed(error: Error, { cancelled }: { cancelled: boolean }) {
    await this.#post(
      this.#formatter.failure(error, { cancelled: cancelled }),
    ).catch((cause: unknown) => {
      this.#warn(toError(cause));
    });
  }

  // Every post respects a newer run's claim, the running status included, so a
  // re-run of an older workflow run can't replace the newer run's review.
  async #post(body: string) {
    const posted = await this.#comment.upsert(body, { onlyIfOwned: true });
    const where = this.#comment.location;
    if (posted) {
      this.#log.write(`Updated the diffcop comment on ${where}\n`);
    } else {
      this.#log.write(
        `A newer run has taken over the diffcop comment on ${where}; leaving it alone\n`,
      );
    }
  }

  #warn(error: Error) {
    this.#log.write(`Couldn't update the diffcop comment: ${String(error)}\n`);
  }
}
