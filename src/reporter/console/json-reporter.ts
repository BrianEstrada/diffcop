import type { ReviewResult } from "@/review/findings";
import type { ReviewReporter, TextSink } from "@/reporter/review-reporter";

// Prints one JSON object when the review is done and nothing before it, so
// stdout parses as a whole.
export class JsonReporter implements ReviewReporter {
  readonly #out: TextSink;
  readonly #warnings: string[] = [];

  constructor(out: TextSink) {
    this.#out = out;
  }

  async started() {}

  async warning(message: string) {
    this.#warnings.push(message);
  }

  toolCall() {}

  thinking() {}

  async verifying() {}

  async completed(result: ReviewResult) {
    // `warnings` is always there, so `jq .warnings[]` works on any run.
    const output = {
      ...result,
      warnings: this.#warnings,
    };
    this.#out.write(`${JSON.stringify(output, null, 2)}\n`);
  }

  // The CLI prints the error to stderr and exits non-zero.
  async failed() {}
}
