import { toError } from "@/util/errors";
import type { ReviewResult } from "@/review/findings";
import { thinkingLine, toolCallLine, verifyingLine } from "@/reporter/progress";
import type { ReviewReporter, TextSink } from "@/reporter/review-reporter";
import {
  REVIEWING,
  failureStatus,
  reviewStatus,
} from "@/reporter/github/commit-status";
import type { CommitStatus } from "@/reporter/github/commit-status";
import type { ReviewCommentFormatter } from "@/reporter/github/review-comment-formatter";
import type { StickyComment } from "@/reporter/github/sticky-comment";

export interface GitHubReporterOptions {
  // Also log tool calls and thinking time, to see where a slow run went.
  debug?: boolean;
}

export class GitHubReporter implements ReviewReporter {
  readonly #comment: StickyComment;
  readonly #formatter: ReviewCommentFormatter;
  readonly #status: Pick<CommitStatus, "post">;
  readonly #log: TextSink;
  readonly #debug: boolean;

  constructor(
    comment: StickyComment,
    formatter: ReviewCommentFormatter,
    status: Pick<CommitStatus, "post">,
    log: TextSink,
    { debug = false }: GitHubReporterOptions = {},
  ) {
    this.#comment = comment;
    this.#formatter = formatter;
    this.#status = status;
    this.#log = log;
    this.#debug = debug;
  }

  // Only a status update, so a failure here (e.g. a GitHub API blip) doesn't
  // stop the review; the result is still posted when it's done.
  async started() {
    if (await this.#postRunning()) {
      await this.#status.post(REVIEWING);
    }
  }

  // Re-posts the running comment so the warning shows while the review runs.
  async warning(message: string) {
    this.#formatter.addWarning(message);
    await this.#postRunning();
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
    if (await this.#post(this.#formatter.review(result))) {
      await this.#status.post(reviewStatus(result, this.#comment.url));
    }
  }

  async failed(error: Error, { cancelled }: { cancelled: boolean }) {
    const body = this.#formatter.failure(error, { cancelled: cancelled });
    if (await this.#postOrWarn(body)) {
      await this.#status.post(failureStatus(cancelled));
    }
  }

  #postRunning() {
    return this.#postOrWarn(this.#formatter.running());
  }

  // False only when a newer run owns the comment, and then the commit's status is that run's too.
  async #postOrWarn(body: string) {
    try {
      return await this.#post(body);
    } catch (cause) {
      this.#warn(toError(cause));
      return true;
    }
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
    return posted;
  }

  #warn(error: Error) {
    this.#log.write(`Couldn't update the diffcop comment: ${String(error)}\n`);
  }
}
