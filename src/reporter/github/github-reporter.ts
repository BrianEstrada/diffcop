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
import type { ReviewComments } from "@/reporter/github/review-comments";

export interface GitHubReporterOptions {
  // Also log tool calls and thinking time, to see where a slow run went.
  debug?: boolean;
}

export class GitHubReporter implements ReviewReporter {
  readonly #comment: ReviewComments;
  readonly #formatter: ReviewCommentFormatter;
  readonly #status: Pick<CommitStatus, "post">;
  readonly #log: TextSink;
  readonly #debug: boolean;

  constructor(
    comment: ReviewComments,
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

  // Nothing is posted to the PR while the review runs: the status shows that it's
  // running, and the comment is posted when there's a review to read.
  async started() {
    if (!(await this.#superseded())) {
      await this.#status.post(REVIEWING);
    }
  }

  // Kept for the comment the review ends with.
  async warning(message: string) {
    this.#formatter.addWarning(message);
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

  // A failed post throws: the run should fail, not pass without its review.
  async completed(result: ReviewResult) {
    if (await this.#post(this.#formatter.review(result))) {
      await this.#hideOutdated();
      await this.#status.post(reviewStatus(result, this.#comment.url));
    }
  }

  // A cancelled run posts no comment: mostly a newer push cancelled it, and that push's review follows.
  async failed(error: Error, { cancelled }: { cancelled: boolean }) {
    if (cancelled) {
      if (!(await this.#superseded())) {
        await this.#status.post(failureStatus(true));
      }
      return;
    }
    if (await this.#postOrWarn(this.#formatter.failure(error))) {
      await this.#status.post(failureStatus(false));
    }
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

  // A run that can't tell goes on as if it weren't: the post that ends it checks again.
  async #superseded() {
    try {
      return await this.#comment.superseded();
    } catch {
      return false;
    }
  }

  // Each commit's review is a comment of its own, and a re-run of an older
  // workflow run can't replace or follow a newer run's.
  async #post(body: string) {
    const posted = await this.#comment.upsert(body, { onlyIfOwned: true });
    const where = this.#comment.location;
    if (posted) {
      this.#log.write(`Posted the diffcop comment on ${where}\n`);
    } else {
      this.#log.write(
        `A newer run has taken over the diffcop comment on ${where}; leaving it alone\n`,
      );
    }
    return posted;
  }

  // The review is posted by now, so a comment left showing isn't worth failing the run for.
  async #hideOutdated() {
    try {
      const hidden = await this.#comment.hideOutdated();
      if (hidden > 0) {
        this.#log.write(
          `Hid ${hidden} earlier diffcop comment${hidden === 1 ? "" : "s"} as outdated\n`,
        );
      }
    } catch (cause) {
      this.#log.write(
        `Couldn't hide the earlier diffcop comments: ${String(toError(cause))}\n`,
      );
    }
  }

  #warn(error: Error) {
    this.#log.write(`Couldn't post the diffcop comment: ${String(error)}\n`);
  }
}
