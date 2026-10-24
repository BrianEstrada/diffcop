import type { ReviewerAgent } from "@/agent/reviewer-agent";
import type { ReviewContextCollector } from "@/context/review-context-collector";
import { toError } from "@/util/errors";
import type { ReviewPromptBuilder } from "@/prompt/review-prompt-builder";
import type { ReviewReporter } from "@/reporter/review-reporter";
import { staleBaseWarning } from "@/review/change-size-limit";
import type { ChangeSizeLimit } from "@/review/change-size-limit";
import { FindAndVerify } from "@/review/find-and-verify";
import type { ReviewResult } from "@/review/findings";

export interface ReviewRequest {
  request: string;
  base?: string;
  abortSignal?: AbortSignal;
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
  ) {
    this.#collector = collector;
    this.#promptBuilder = promptBuilder;
    this.#findAndVerify = new FindAndVerify(promptBuilder, agent, reporter);
    this.#reporter = reporter;
    this.#sizeLimit = sizeLimit;
  }

  async review({
    request,
    base,
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
        this.#promptBuilder.build(context, request),
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
