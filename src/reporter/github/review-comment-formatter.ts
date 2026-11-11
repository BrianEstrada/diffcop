import type { RunStats } from "@/agent/reviewer-agent";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import type { ReviewResult } from "@/review/findings";
import { appendRound } from "@/review/review-ledger";
import type { ReviewLedger } from "@/review/review-ledger";
import { summarizeFinders } from "@/review/saved-review";
import type { SavedReview } from "@/review/saved-review";
import { ledgerMarker } from "@/reporter/github/ledger-marker";
import { savedReviewMarker } from "@/reporter/github/saved-review-marker";
import { reviewLayout, sectionHeading } from "@/reporter/review-layout";
import type { ReviewLayout, ReviewSection } from "@/reporter/review-layout";
import { runDetailsSection } from "@/reporter/run-details";

// GitHub rejects comment bodies over 65,536 characters.
const MAX_COMMENT_CHARS = 60_000;
// Room left under GitHub's limit for the markers `StickyComment` adds.
const MAX_SAVED_COMMENT_CHARS = 65_000;
const MAX_ERROR_CHARS = 2_000;
// The ledger's share of the comment, taken out of the visible review's.
const MAX_LEDGER_CHARS = 20_000;

const TRUNCATED = "_Review truncated; see the job log for the rest._";
const BLOCK_GAP = "\n\n";

// Blank lines inside <details> let GitHub render the body as markdown.
function details(section: ReviewSection, body: string) {
  const tag = section.open ? "<details open>" : "<details>";
  return [
    `${tag}<summary><b>${sectionHeading(section)}</b></summary>`,
    "",
    body,
    "",
    "</details>",
  ].join("\n");
}

export interface ReviewCommentFormatterOptions {
  // Scrubbed from everything posted, since PR comments aren't masked the way
  // Actions logs are, and the reviewer can read files outside the repo.
  secrets?: (string | undefined)[];
}

export class ReviewCommentFormatter {
  readonly #pr: PullRequestContext;
  readonly #secrets: string[];
  readonly #warnings: string[] = [];
  #ledger: ReviewLedger | undefined;

  constructor(
    pr: PullRequestContext,
    { secrets = [] }: ReviewCommentFormatterOptions = {},
  ) {
    this.#pr = pr;
    // Longest first, so a secret that contains another isn't left half-redacted.
    this.#secrets = secrets
      .filter((secret): secret is string => {
        return Boolean(secret);
      })
      .toSorted((a, b) => {
        return b.length - a.length;
      });
  }

  // Shown at the top of every comment formatted after this.
  addWarning(message: string) {
    this.#warnings.push(message);
  }

  // Read from the comment before this run replaces it. Every status posted from
  // here on carries it, so a failed or cancelled run doesn't lose the earlier rounds.
  setLedger(ledger: ReviewLedger | undefined) {
    this.#ledger = ledger;
  }

  running() {
    return this.#withLedger(
      this.#frame([
        `⏳ Reviewing \`${this.#shortSha()}\`…${this.#runLink("Follow the run")}`,
      ]),
    );
  }

  failure(error: Error, { cancelled = false } = {}) {
    if (cancelled) {
      return this.#withLedger(
        this.#frame([
          `⚪ The review of \`${this.#shortSha()}\` was cancelled before it finished.${this.#runLink("See the run")}`,
        ]),
      );
    }
    return this.#withLedger(
      this.#frame([
        `❌ The review of \`${this.#shortSha()}\` failed.${this.#runLink("See the run log")}`,
        "",
        "```",
        this.#errorMessage(error),
        "```",
      ]),
    );
  }

  // Saves each finder's numbers but not its file paths or the merged findings, to keep the saved review small.
  review(reviewed: ReviewResult) {
    const { finders, merged, ...result } = reviewed;
    return this.savedReview(
      {
        version: 1,
        headSha: this.#pr.headSha,
        descriptionAt: this.#pr.triggerTime,
        warnings: [...this.#warnings],
        result: result,
        finders: summarizeFinders(finders ?? []),
        merged: merged?.length ?? 0,
      },
      { ledger: appendRound(this.#ledger, this.#pr.headSha, reviewed) },
    );
  }

  // `recheck` is the run that re-checked only the description, listed under the review's own
  // run. `ledger` is kept in the comment as given, ahead of the saved review when both don't fit.
  savedReview(
    saved: SavedReview,
    { recheck, ledger }: { recheck?: RunStats; ledger?: ReviewLedger } = {},
  ) {
    const { headSha, warnings, result } = saved;
    const reviewed = [`Reviewed ${headSha.slice(0, 7)}`];
    const since = result.rereview?.since;
    if (since !== undefined) {
      reviewed.push(`focused on changes since ${since.slice(0, 7)}`);
    }
    const footer = [reviewed.join(", ")];
    const run = this.#runLink("run").trim();
    if (run) {
      footer.push(run);
    }
    const runDetails = runDetailsSection({
      stats: result.stats,
      recheck: recheck,
      finders: saved.finders,
      merged: saved.merged,
      since: since,
    });
    // Set aside before the review's own sections, so a long review can't truncate the run's numbers away.
    const runBlock = details(runDetails, this.#redact(runDetails.body));
    const kept = ledger && this.#ledgerMarker(ledger);
    const ledgerChars = kept ? kept.length + 1 : 0;
    const room =
      MAX_COMMENT_CHARS - ledgerChars - BLOCK_GAP.length - runBlock.length;
    const body = this.#frame(
      [
        this.#body(reviewLayout(result), room),
        "",
        runBlock,
        "",
        "---",
        `<sub>${footer.join(" · ")}</sub>`,
      ],
      warnings,
    );
    const withLedger = [body, ...(kept ? [kept] : [])].join("\n");
    const marker = savedReviewMarker(saved, this.#secrets);
    if (withLedger.length + 1 + marker.length > MAX_SAVED_COMMENT_CHARS) {
      return withLedger;
    }
    return `${withLedger}\n${marker}`;
  }

  #ledgerMarker(ledger: ReviewLedger) {
    return ledgerMarker(ledger, this.#secrets, MAX_LEDGER_CHARS);
  }

  #withLedger(body: string) {
    const kept = this.#ledger && this.#ledgerMarker(this.#ledger);
    return [body, ...(kept ? [kept] : [])].join("\n");
  }

  // Truncates inside a section's body, so a cut never leaves <details> open.
  #body({ headline, sections }: ReviewLayout, maxChars: number) {
    const top = `${headline.icon} **${headline.text}**`;
    const blocks = [top];
    let room = maxChars - top.length;
    for (const section of sections) {
      const body = this.#redact(section.body);
      const block = details(section, body);
      if (BLOCK_GAP.length + block.length <= room) {
        blocks.push(block);
        room -= BLOCK_GAP.length + block.length;
        continue;
      }
      const ending = `${BLOCK_GAP}${TRUNCATED}`;
      const overhead = BLOCK_GAP.length + details(section, ending).length;
      const kept = body.slice(0, Math.max(0, room - overhead));
      blocks.push(details(section, `${kept}${ending}`));
      break;
    }
    return blocks.join(BLOCK_GAP);
  }

  #errorMessage(error: Error) {
    const message = this.#redact(error.message);
    // Keep the message inside its code fence.
    return message.slice(0, MAX_ERROR_CHARS).replaceAll("```", "'''");
  }

  #redact(text: string) {
    let redacted = text;
    for (const secret of this.#secrets) {
      redacted = redacted.replaceAll(secret, "***");
    }
    return redacted;
  }

  #frame(lines: string[], warnings = this.#warnings) {
    const alerts = warnings.flatMap((warning) => {
      return ["> [!WARNING]", `> ${warning}`, ""];
    });
    return ["## diffcop review", "", ...alerts, ...lines].join("\n");
  }

  #shortSha() {
    return this.#pr.headSha.slice(0, 7);
  }

  #runLink(label: string) {
    if (!this.#pr.runUrl) {
      return "";
    }
    return ` [${label}](${this.#pr.runUrl})`;
  }
}
