import { mergeExplored } from "@/agent/explored";
import { sumStats } from "@/agent/reviewer-agent";
import type { ReviewerAgent } from "@/agent/reviewer-agent";
import type { ReviewContext } from "@/context/review-context-collector";
import type {
  ReviewPrompt,
  ReviewPromptBuilder,
} from "@/prompt/review-prompt-builder";
import type { ReviewReporter } from "@/reporter/review-reporter";
import {
  findingsSchema,
  splitByVerdict,
  verdictsSchema,
} from "@/review/findings";
import type { Finding, ReviewResult } from "@/review/findings";

// A second pass tries to refute each finding before it's reported.
export class FindAndVerify {
  readonly #promptBuilder: ReviewPromptBuilder;
  readonly #agent: ReviewerAgent;
  readonly #reporter: ReviewReporter;

  constructor(
    promptBuilder: ReviewPromptBuilder,
    agent: ReviewerAgent,
    reporter: ReviewReporter,
  ) {
    this.#promptBuilder = promptBuilder;
    this.#agent = agent;
    this.#reporter = reporter;
  }

  // `keep` filters the finder's findings before they're verified.
  async run(
    context: ReviewContext,
    prompt: ReviewPrompt,
    {
      abortSignal,
      keep = () => {
        return true;
      },
    }: { abortSignal?: AbortSignal; keep?: (finding: Finding) => boolean } = {},
  ): Promise<ReviewResult> {
    const found = await this.#agent.run({
      cwd: context.repoRoot,
      prompt: prompt,
      output: findingsSchema,
      reporter: this.#reporter,
      abortSignal: abortSignal,
    });
    const { summary } = found.output;
    const findings = found.output.findings.filter(keep);
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
