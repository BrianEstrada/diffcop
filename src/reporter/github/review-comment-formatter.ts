import type { RunStats } from "@/agent/reviewer-agent";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import type { ReviewResult } from "@/review/findings";
import type { SavedReview } from "@/review/saved-review";
import { savedReviewMarker } from "@/reporter/github/saved-review-marker";
import { reviewLayout, sectionHeading } from "@/reporter/review-layout";
import type { ReviewLayout, ReviewSection } from "@/reporter/review-layout";
import { formatStats } from "@/reporter/stats";

// GitHub rejects comment bodies over 65,536 characters.
const MAX_COMMENT_CHARS = 60_000;
// Room left under GitHub's limit for the markers `StickyComment` adds.
const MAX_SAVED_COMMENT_CHARS = 65_000;
const MAX_ERROR_CHARS = 2_000;

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

  running() {
    return this.#frame([
      `⏳ Reviewing \`${this.#shortSha()}\`…${this.#runLink("Follow the run")}`,
    ]);
  }

  failure(error: Error, { cancelled = false } = {}) {
    if (cancelled) {
      return this.#frame([
        `⚪ The review of \`${this.#shortSha()}\` was cancelled before it finished.${this.#runLink("See the run")}`,
      ]);
    }
    return this.#frame([
      `❌ The review of \`${this.#shortSha()}\` failed.${this.#runLink("See the run log")}`,
      "",
      "```",
      this.#errorMessage(error),
      "```",
    ]);
  }

  review(result: ReviewResult) {
    return this.savedReview({
      version: 1,
      headSha: this.#pr.headSha,
      descriptionAt: this.#pr.triggerTime,
      warnings: [...this.#warnings],
      result: result,
    });
  }

  // `recheck` is the run that re-checked only the description, shown beside the review's own stats.
  savedReview(saved: SavedReview, { recheck }: { recheck?: RunStats } = {}) {
    const { headSha, warnings, result } = saved;
    const footer = [
      `Reviewed ${headSha.slice(0, 7)}`,
      formatStats(result.stats),
    ];
    if (recheck) {
      footer.push(`description re-checked in ${formatStats(recheck)}`);
    }
    const body = this.#frame(
      [
        this.#body(reviewLayout(result)),
        "",
        "---",
        `<sub>${footer.join(" · ")}${this.#runLink("run")}</sub>`,
      ],
      warnings,
    );
    const marker = savedReviewMarker(saved, this.#secrets);
    if (body.length + 1 + marker.length > MAX_SAVED_COMMENT_CHARS) {
      return body;
    }
    return `${body}\n${marker}`;
  }

  // Truncates inside a section's body, so a cut never leaves <details> open.
  #body({ headline, sections }: ReviewLayout) {
    const top = `${headline.icon} **${headline.text}**`;
    const blocks = [top];
    let room = MAX_COMMENT_CHARS - top.length;
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
