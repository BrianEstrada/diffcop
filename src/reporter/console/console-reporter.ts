import type { ReviewResult } from "../../review/findings";
import { thinkingLine, toolCallLine, verifyingLine } from "../progress";
import { reviewLayout, sectionHeading } from "../review-layout";
import type { ReviewLayout } from "../review-layout";
import type { ReviewReporter, TextSink } from "../review-reporter";
import { formatStats } from "../stats";

function formatMarkdown({ headline, sections }: ReviewLayout) {
  return [
    `${headline.icon} **${headline.text}**`,
    ...sections.map((section) => {
      return `## ${sectionHeading(section)}\n\n${section.body}`;
    }),
  ].join("\n\n");
}

export interface ConsoleReporterOptions {
  // Off when stdout isn't a terminal, so piped output has no escape codes.
  colors?: boolean;
  columns?: number;
}

// The findings go to `out`; tool calls, thinking time, phases and stats go to
// `err`, so redirecting stdout captures only the review.
export class ConsoleReporter implements ReviewReporter {
  readonly #out: TextSink;
  readonly #err: TextSink;
  readonly #options: ConsoleReporterOptions;

  constructor(
    out: TextSink,
    err: TextSink,
    options: ConsoleReporterOptions = {},
  ) {
    this.#out = out;
    this.#err = err;
    this.#options = options;
  }

  async started() {}

  async warning(message: string) {
    this.#err.write(`\n⚠ ${message}\n`);
  }

  toolCall(toolName: string, input: unknown) {
    this.#err.write(`\n${toolCallLine(toolName, input)}\n`);
  }

  thinking(durationMs: number) {
    this.#err.write(`\n${thinkingLine(durationMs)}\n`);
  }

  async verifying(findings: number) {
    this.#err.write(`\n${verifyingLine(findings)}\n`);
  }

  async completed(result: ReviewResult) {
    const { stats } = result;
    this.#err.write(`\n› done: ${formatStats(stats)}\n\n`);
    const markdown = formatMarkdown(reviewLayout(result, { html: false }));
    this.#out.write(
      Bun.markdown.ansi(markdown, {
        colors: this.#options.colors ?? false,
        columns: this.#options.columns ?? 80,
      }),
    );
  }

  // The CLI prints the error itself.
  async failed() {}
}
