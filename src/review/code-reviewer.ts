import { mergeExplored } from "@/agent/explored";
import { sumStats } from "@/agent/reviewer-agent";
import type { ReviewerAgent } from "@/agent/reviewer-agent";
import type {
  ReviewContext,
  ReviewContextCollector,
} from "@/context/review-context-collector";
import { toError } from "@/util/errors";
import type { ReviewPromptBuilder } from "@/prompt/review-prompt-builder";
import type { ReviewReporter } from "@/reporter/review-reporter";
import { staleBaseWarning } from "@/review/change-size-limit";
import type { ChangeSizeLimit } from "@/review/change-size-limit";
import {
  findingsSchema,
  splitByVerdict,
  verdictsSchema,
} from "@/review/findings";
import type { ReviewResult } from "@/review/findings";

export interface ReviewRequest {
  request: string;
  base?: string;
  abortSignal?: AbortSignal;
}

// Modeled on claude-code-action's context → prompt → agent pipeline, with a
// second pass that tries to refute each finding before it's reported.
export class CodeReviewer {
  readonly #collector: ReviewContextCollector;
  readonly #promptBuilder: ReviewPromptBuilder;
  readonly #agent: ReviewerAgent;
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
    this.#agent = agent;
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
      const result = await this.#findAndVerify(context, request, abortSignal);
      await this.#reporter.completed(result);
      return result;
    } catch (error) {
      await this.#reporter.failed(toError(error), {
        cancelled: abortSignal?.aborted ?? false,
      });
      throw error;
    }
  }

  async #findAndVerify(
    context: ReviewContext,
    request: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<ReviewResult> {
    const found = await this.#agent.run({
      cwd: context.repoRoot,
      prompt: this.#promptBuilder.build(context, request),
      output: findingsSchema,
      reporter: this.#reporter,
      abortSignal: abortSignal,
    });
    const { summary, findings } = found.output;
    if (findings.length === 0) {
      return {
        summary: summary,
        findings: findings,
        dropped: [],
        explored: found.explored,
        stats: found.stats,
      };
    }

    await this.#reporter.verifying(findings.length);
    const verified = await this.#agent.run({
      cwd: context.repoRoot,
      prompt: this.#promptBuilder.buildVerification(context, findings),
      output: verdictsSchema,
      reporter: this.#reporter,
      abortSignal: abortSignal,
    });
    const { confirmed, dropped } = splitByVerdict(
      findings,
      verified.output.verdicts,
    );
    return {
      summary: summary,
      findings: confirmed,
      dropped: dropped,
      explored: mergeExplored(found.explored, verified.explored),
      stats: sumStats(found.stats, verified.stats),
    };
  }
}
