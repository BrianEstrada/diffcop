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
  SettledFinding,
} from "@/review/findings";
import { touchesDelta } from "@/review/review-delta";
import type { ReviewDelta } from "@/review/review-delta";
import { carriedFindings, isMajor } from "@/review/review-ledger";
import { toError } from "@/util/errors";
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

// Code an earlier round already saw gets no second pass for minor findings: each
// round would otherwise turn up a few more, and the review would never settle.
function staysOnRereview(finding: Finding, delta: ReviewDelta | undefined) {
  return (
    !delta ||
    isMajor(finding) ||
    finding.scope === "description" ||
    touchesDelta(finding, delta)
  );
}

function count(lists: Finding[][]) {
  return lists.reduce((sum, list) => {
    return sum + list.length;
  }, 0);
}

function finderFailedWarning(files: string[] | undefined, error: Error) {
  if (!files) {
    return `The whole-diff finder failed, so bugs that span files may be missed: ${error.message}`;
  }
  return `A finder for ${files.join(", ")} failed, so those files got one review fewer: ${error.message}`;
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
    const settled = await Promise.allSettled(
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
    const errors = settled.map((outcome) => {
      if (outcome.status === "fulfilled") {
        return undefined;
      }
      return toError(outcome.reason);
    });
    const [firstError] = errors.filter((error) => {
      return error !== undefined;
    });
    // One finder failing costs its share of the review, not the whole review.
    if (firstError && (abortSignal?.aborted || errors.every(Boolean))) {
      throw firstError;
    }
    for (const [index, error] of errors.entries()) {
      if (error) {
        await this.#reporter.warning(
          finderFailedWarning(finders[index]?.files, error),
        );
      }
    }
    const found = settled.flatMap((outcome) => {
      return outcome.status === "fulfilled" ? [outcome.value] : [];
    });
    const summary = found
      .map((run) => {
        return run.output.summary.trim();
      })
      .filter(Boolean)
      .join(" ");
    const { previous } = context;
    const reported = settled.map((outcome) => {
      if (outcome.status === "rejected") {
        return [];
      }
      return outcome.value.output.findings.filter(keep);
    });
    const kept = reported.map((list) => {
      return list.filter((finding) => {
        return staysOnRereview(finding, previous?.delta);
      });
    });
    const fresh = kept.flat();
    let findings = fresh;
    const merging: AgentResult<unknown>[] = [];
    const merged: MergedFinding[] = [];
    if (found.length > 1 && findings.length > 1) {
      const deduplicated = await this.#deduplicate(
        context,
        findings,
        abortSignal,
      );
      if (deduplicated) {
        const deduped = removeDuplicates(
          findings,
          deduplicated.output.duplicates,
        );
        findings = deduped.kept;
        merged.push(...deduped.merged);
        merging.push(deduplicated);
      }
    }
    // Carried findings skip the merge and get a verdict of their own: one merged into a finder's
    // similar finding would share that finding's fate, and be called fixed when it was refuted.
    // Grows as the verifier marks one a repeat of another in its batch, which then stands for it.
    const carried = new Set(previous ? carriedFindings(previous.rounds) : []);
    findings = [...findings, ...carried];

    const verified: AgentResult<unknown>[] = [];
    const confirmed: Finding[] = [];
    const dropped: DroppedFinding[] = [];
    const settledEarlier: SettledFinding[] = [];
    const fixed: SettledFinding[] = [];
    let stillOpen = 0;
    if (findings.length > 0) {
      await this.#reporter.verifying(findings.length);
      const batches = verificationBatches(findings);
      const results = await mapLimit(
        batches,
        VERIFY_CONCURRENCY,
        async (batch) => {
          return await this.#agent.run({
            cwd: context.repoRoot,
            prompt: this.#promptBuilder.buildVerification(
              context,
              batch,
              carried,
            ),
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
        for (const [finding, original] of split.duplicates) {
          if (carried.has(finding)) {
            carried.add(original);
          }
        }
        confirmed.push(...split.confirmed);
        stillOpen += split.confirmedFrom.filter((finding) => {
          return carried.has(finding);
        }).length;
        for (const judged of split.dropped) {
          if (!carried.has(judged.finding)) {
            dropped.push(judged);
          } else if (split.refuted.has(judged.finding)) {
            fixed.push(judged);
          } else {
            // An earlier round verified it, and no clear verdict now isn't a sign it was fixed.
            confirmed.push(judged.finding);
            stillOpen += 1;
          }
        }
        // Without earlier rounds nothing can be settled, so the verdict counts as a refutation.
        (previous ? settledEarlier : dropped).push(...split.settled);
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
    if (previous) {
      result.rereview = {
        ...(previous.delta && { since: previous.delta.since }),
        settled: settledEarlier,
        fixed: fixed,
        stillOpen: stillOpen,
        leftOut: count(reported) - count(kept),
      };
    }
    if (finders.length > 1) {
      result.finders = finders.map(({ files, chunk, lines }, index) => {
        const outcome = settled[index];
        const finder: FinderRun = {
          findings: kept[index]?.length ?? 0,
        };
        if (files) {
          finder.files = files;
        }
        if (chunk !== undefined && lines !== undefined) {
          finder.chunk = chunk;
          finder.lines = lines;
        }
        if (outcome?.status === "fulfilled") {
          finder.stats = outcome.value.stats;
        }
        const error = errors[index];
        if (error) {
          finder.error = error.message;
        }
        return finder;
      });
      result.merged = merged;
    }
    return result;
  }

  // Dedupe only trims repeats, so a failed session leaves the findings as they are.
  async #deduplicate(
    context: ReviewContext,
    findings: Finding[],
    abortSignal: AbortSignal | undefined,
  ) {
    try {
      return await this.#agent.run({
        cwd: context.repoRoot,
        prompt: this.#promptBuilder.buildDeduplication(findings),
        output: duplicatesSchema,
        reporter: this.#reporter,
        abortSignal: abortSignal,
      });
    } catch (error) {
      if (abortSignal?.aborted) {
        throw error;
      }
      await this.#reporter.warning(
        `Merging duplicate findings failed, so some may be listed twice: ${toError(error).message}`,
      );
      return undefined;
    }
  }
}
