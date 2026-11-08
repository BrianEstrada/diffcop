import { mergeExplored } from "@/agent/explored";
import { sumStats } from "@/agent/reviewer-agent";
import type { AgentResult, ReviewerAgent } from "@/agent/reviewer-agent";
import type { ReviewContext } from "@/context/review-context-collector";
import type {
  FinderPrompt,
  ReviewPromptBuilder,
} from "@/prompt/review-prompt-builder";
import type { ReviewReporter } from "@/reporter/review-reporter";
import {
  duplicatesSchema,
  findingsSchema,
  removeDuplicates,
  splitByVerdict,
  verdictsSchema,
} from "@/review/findings";
import type {
  DroppedFinding,
  Finding,
  FinderRun,
  MergedFinding,
  ReviewResult,
} from "@/review/findings";
import { mapLimit } from "@/util/map-limit";

// Small batches so each finding gets the verifier's attention; one session
// judging a long list flip-flopped between runs.
const VERIFY_BATCH_SIZE = 5;

// Concurrent verifier sessions, kept low for subscription rate limits.
const VERIFY_CONCURRENCY = 4;

// By file, in line order, so findings that could repeat each other share a batch
// and the verifier can mark the duplicates.
export function verificationBatches(findings: Finding[]) {
  const byFile = Map.groupBy(findings, (finding) => {
    return finding.file;
  });
  return [...byFile.values()].flatMap((group) => {
    const sorted = group.toSorted((a, b) => {
      return a.startLine - b.startLine;
    });
    const batches: Finding[][] = [];
    for (let i = 0; i < sorted.length; i += VERIFY_BATCH_SIZE) {
      batches.push(sorted.slice(i, i + VERIFY_BATCH_SIZE));
    }
    return batches;
  });
}

function mergeRuns(runs: AgentResult<unknown>[]) {
  const [first, ...rest] = runs;
  if (!first) {
    throw new Error("No runs to merge");
  }
  return rest.reduce(
    (merged, run) => {
      return {
        explored: mergeExplored(merged.explored, run.explored),
        stats: sumStats(merged.stats, run.stats),
      };
    },
    {
      explored: first.explored,
      stats: first.stats,
    },
  );
}

// Finders run in parallel and their findings are pooled and deduplicated; a
// second pass then tries to refute each finding before it's reported.
export class FindAndVerify {
  readonly #promptBuilder: ReviewPromptBuilder;
  readonly #agent: ReviewerAgent;
  readonly #reporter: ReviewReporter;
  readonly #now: () => number;

  constructor(
    promptBuilder: ReviewPromptBuilder,
    agent: ReviewerAgent,
    reporter: ReviewReporter,
    now: () => number = () => {
      return performance.now();
    },
  ) {
    this.#promptBuilder = promptBuilder;
    this.#agent = agent;
    this.#reporter = reporter;
    this.#now = now;
  }

  // `keep` filters the finders' findings before they're verified.
  async run(
    context: ReviewContext,
    finders: FinderPrompt[],
    {
      abortSignal,
      keep = () => {
        return true;
      },
    }: { abortSignal?: AbortSignal; keep?: (finding: Finding) => boolean } = {},
  ): Promise<ReviewResult> {
    const startedAt = this.#now();
    const found = await Promise.all(
      finders.map(({ prompt }) => {
        return this.#agent.run({
          cwd: context.repoRoot,
          prompt: prompt,
          output: findingsSchema,
          reporter: this.#reporter,
          abortSignal: abortSignal,
        });
      }),
    );
    const summary = found
      .map((run) => {
        return run.output.summary.trim();
      })
      .filter(Boolean)
      .join(" ");
    const kept = found.map((run) => {
      return run.output.findings.filter(keep);
    });
    let findings = kept.flat();
    const merging: AgentResult<unknown>[] = [];
    const merged: MergedFinding[] = [];
    if (found.length > 1 && findings.length > 1) {
      const deduplicated = await this.#agent.run({
        cwd: context.repoRoot,
        prompt: this.#promptBuilder.buildDeduplication(findings),
        output: duplicatesSchema,
        reporter: this.#reporter,
        abortSignal: abortSignal,
      });
      const deduped = removeDuplicates(
        findings,
        deduplicated.output.duplicates,
      );
      findings = deduped.kept;
      merged.push(...deduped.merged);
      merging.push(deduplicated);
    }

    const verified: AgentResult<unknown>[] = [];
    const confirmed: Finding[] = [];
    const dropped: DroppedFinding[] = [];
    if (findings.length > 0) {
      await this.#reporter.verifying(findings.length);
      const batches = verificationBatches(findings);
      const results = await mapLimit(
        batches,
        VERIFY_CONCURRENCY,
        async (batch) => {
          return await this.#agent.run({
            cwd: context.repoRoot,
            prompt: this.#promptBuilder.buildVerification(context, batch),
            output: verdictsSchema,
            reporter: this.#reporter,
            abortSignal: abortSignal,
          });
        },
      );
      results.forEach((result, index) => {
        const split = splitByVerdict(
          batches[index] ?? [],
          result.output.verdicts,
        );
        confirmed.push(...split.confirmed);
        dropped.push(...split.dropped);
        verified.push(result);
      });
    }

    const runs = mergeRuns([...found, ...merging, ...verified]);
    const result: ReviewResult = {
      summary: summary,
      findings: confirmed,
      dropped: dropped,
      explored: runs.explored,
      // Wall time: the summed durations of parallel runs would overstate it.
      stats: {
        ...runs.stats,
        durationMs: this.#now() - startedAt,
      },
    };
    if (finders.length > 1) {
      result.finders = finders.map(({ files }, index) => {
        const run = found[index];
        const finder: FinderRun = {
          findings: kept[index]?.length ?? 0,
          stats: run?.stats ?? runs.stats,
        };
        if (files) {
          finder.files = files;
        }
        return finder;
      });
      result.merged = merged;
    }
    return result;
  }
}
