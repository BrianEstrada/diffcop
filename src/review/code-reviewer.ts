import type { ReviewerAgent } from "@/agent/reviewer-agent";
import type { ReviewContextCollector } from "@/context/review-context-collector";
import { toError } from "@/util/errors";
import { FINDER_LENSES } from "@/prompt/review-prompt-builder";
import type { ReviewPromptBuilder } from "@/prompt/review-prompt-builder";
import type { ChangedFile } from "@/context/repository";
import type { ReviewReporter } from "@/reporter/review-reporter";
import {
  measureChangeSize,
  staleBaseWarning,
} from "@/review/change-size-limit";
import type { ChangeSizeLimit } from "@/review/change-size-limit";
import { FindAndVerify } from "@/review/find-and-verify";
import type { ReviewResult } from "@/review/findings";

export interface ReviewRequest {
  request: string;
  base?: string;
  // Parallel finders, one per lens; 1 runs a single generalist. Defaults to
  // finderCount of the change.
  finders?: number;
  abortSignal?: AbortSignal;
}

const LINES_PER_FINDER = 400;

// One finder per 400 changed lines, lockfiles aside, up to one per lens.
export function finderCount(changedFiles: ChangedFile[]) {
  const { lines } = measureChangeSize(changedFiles);
  return Math.min(
    FINDER_LENSES.length,
    Math.max(1, Math.ceil(lines / LINES_PER_FINDER)),
  );
}

// Modeled on claude-code-action's context → prompt → agent pipeline.
export class CodeReviewer {
  readonly #collector: ReviewContextCollector;
  readonly #promptBuilder: ReviewPromptBuilder;
  readonly #findAndVerify: FindAndVerify;
  readonly #reporter: ReviewReporter;
  readonly #sizeLimit: ChangeSizeLimit;

  constructor(
    collector: ReviewContextCollector,
    promptBuilder: ReviewPromptBuilder,
    agent: ReviewerAgent,
    reporter: ReviewReporter,
    sizeLimit: ChangeSizeLimit,
    now?: () => number,
  ) {
    this.#collector = collector;
    this.#promptBuilder = promptBuilder;
    this.#findAndVerify = new FindAndVerify(
      promptBuilder,
      agent,
      reporter,
      now,
    );
    this.#reporter = reporter;
    this.#sizeLimit = sizeLimit;
  }

  async review({
    request,
    base,
    finders,
    abortSignal,
  }: ReviewRequest): Promise<ReviewResult> {
    await this.#reporter.started();
    try {
      const context = await this.#collector.collect(base);
      const sizeWarning =
        staleBaseWarning(
          context.base,
          context.changedFiles.length,
          context.pullRequest?.data.files?.totalCount,
        ) ?? this.#sizeLimit.warning(context.changedFiles);
      if (sizeWarning) {
        await this.#reporter.warning(sizeWarning);
      }
      const result = await this.#findAndVerify.run(
        context,
        this.#promptBuilder.buildFinders(
          context,
          request,
          finders ?? finderCount(context.changedFiles),
        ),
        { abortSignal: abortSignal },
      );
      await this.#reporter.completed(result);
      return result;
    } catch (error) {
      await this.#reporter.failed(toError(error), {
        cancelled: abortSignal?.aborted ?? false,
      });
      throw error;
    }
  }
}
