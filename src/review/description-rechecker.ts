import { mergeExplored } from "@/agent/explored";
import type { RunStats } from "@/agent/reviewer-agent";
import type { ReviewContextCollector } from "@/context/review-context-collector";
import type { ReviewPromptBuilder } from "@/prompt/review-prompt-builder";
import type { FindAndVerify } from "@/review/find-and-verify";
import {
  isDescriptionFinding,
  withDescriptionFindings,
} from "@/review/saved-review";
import type { SavedReview } from "@/review/saved-review";

export interface SavedReviewStore {
  load(): Promise<SavedReview | undefined>;
  // Reads the saved review again before writing; `update` returns undefined to leave it.
  save(
    update: (current: SavedReview) => SavedReview | undefined,
    recheck: RunStats,
  ): Promise<boolean>;
}

export interface DescriptionEdit {
  headSha: string;
  // The edit's event time, which orders re-checks of edits made close together.
  descriptionAt?: string;
}

export type RecheckOutcome =
  | { status: "skipped"; reason: string }
  | { status: "superseded" }
  | { status: "rechecked"; findings: number };

// After an edit of the title or body alone, re-checks the description findings of the last
// review and keeps its code findings, rather than reviewing code that hasn't changed.
export class DescriptionRechecker {
  readonly #collector: ReviewContextCollector;
  readonly #promptBuilder: ReviewPromptBuilder;
  readonly #findAndVerify: FindAndVerify;
  readonly #store: SavedReviewStore;

  constructor(
    collector: ReviewContextCollector,
    promptBuilder: ReviewPromptBuilder,
    findAndVerify: FindAndVerify,
    store: SavedReviewStore,
  ) {
    this.#collector = collector;
    this.#promptBuilder = promptBuilder;
    this.#findAndVerify = findAndVerify;
    this.#store = store;
  }

  async recheck(
    { headSha, descriptionAt }: DescriptionEdit,
    { abortSignal }: { abortSignal?: AbortSignal } = {},
  ): Promise<RecheckOutcome> {
    const saved = await this.#store.load();
    if (!saved) {
      return {
        status: "skipped",
        reason: "the comment holds no finished review to re-check",
      };
    }
    if (saved.headSha !== headSha) {
      return {
        status: "skipped",
        reason: `the last review was of ${saved.headSha.slice(0, 7)}, not ${headSha.slice(0, 7)}`,
      };
    }
    const previous = saved.result.findings.filter(isDescriptionFinding);
    if (previous.length === 0) {
      return {
        status: "skipped",
        reason: "the last review found nothing wrong with the description",
      };
    }

    const context = await this.#collector.collect();
    const rechecked = await this.#findAndVerify.run(
      context,
      this.#promptBuilder.buildDescriptionRecheck(context, previous),
      {
        abortSignal: abortSignal,
        keep: isDescriptionFinding,
      },
    );
    const written = await this.#store.save((current) => {
      if (
        current.headSha !== headSha ||
        isNewer(current.descriptionAt, descriptionAt)
      ) {
        return undefined;
      }
      return withDescriptionFindings(current, {
        findings: rechecked.findings,
        dropped: rechecked.dropped,
        explored: mergeExplored(current.result.explored, rechecked.explored),
        descriptionAt: descriptionAt,
      });
    }, rechecked.stats);
    if (!written) {
      return { status: "superseded" };
    }
    return {
      status: "rechecked",
      findings: rechecked.findings.length,
    };
  }
}

// ISO 8601 UTC times, as GitHub sends them, sort as strings.
function isNewer(time: string | undefined, than: string | undefined) {
  return time !== undefined && than !== undefined && time > than;
}
