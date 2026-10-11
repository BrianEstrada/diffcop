import { describe, expect, test } from "bun:test";
import type { TextSink } from "../review-reporter";
import { ConsoleReporter } from "./console-reporter";

class BufferSink implements TextSink {
  text = "";

  write(text: string) {
    this.text += text;
  }
}

describe("ConsoleReporter", () => {
  test("writes the findings to out and everything else to err", async () => {
    const out = new BufferSink();
    const err = new BufferSink();
    const reporter = new ConsoleReporter(out, err);

    await reporter.started();
    reporter.toolCall("read", '{"path":"a.ts"}');
    reporter.thinking(2_400);
    await reporter.verifying(2);
    await reporter.completed({
      summary: "Traced `slice` into its callers.",
      findings: [
        {
          file: "a.ts",
          startLine: 4,
          endLine: 4,
          severity: "medium",
          scope: "introduced",
          title: "Drops the last item",
          explanation: "`slice(0, -1)` skips the final element.",
        },
      ],
      dropped: [
        {
          finding: {
            file: "b.ts",
            startLine: 1,
            endLine: 1,
            severity: "low",
            scope: "introduced",
            title: "Ignores an empty list",
            explanation: "Returns early on [].",
          },
          reason: "Guarded by the caller.",
        },
      ],
      explored: {
        filesRead: ["a.ts"],
        searches: [{ pattern: "slice" }],
      },
      stats: {
        durationMs: 5_000,
        toolCalls: 1,
      },
    });
    for (const text of [
      "🔴 1 issue found",
      "Issues (1)",
      "| 1   | Medium   | a.ts:4   | Drops the last item |",
      "1. slice(0, -1) skips the final element.",
      "Dropped by verification (1)",
      "   Verifier: Guarded by the caller.",
      "What we looked at",
      "Read (1): a.ts",
      "Searched (1): slice",
    ]) {
      expect(out.text).toContain(text);
    }
    expect(out.text).not.toContain("<details");
    expect(err.text).toBe(
      '\n› read {"path":"a.ts"}\n' +
        "\n› thinking (2s)\n" +
        "\n› verifying 2 findings…\n" +
        "\n› done: 5s · 1 tool call\n\n",
    );
  });

  test("writes a warning to err as soon as it's reported", async () => {
    const out = new BufferSink();
    const err = new BufferSink();
    const reporter = new ConsoleReporter(out, err);

    await reporter.warning("This change is large.");

    expect(out.text).toBe("");
    expect(err.text).toBe("\n⚠ This change is large.\n");
  });

  test("says all good when there are no findings", async () => {
    const out = new BufferSink();
    const reporter = new ConsoleReporter(out, new BufferSink());
    await reporter.completed({
      summary: "",
      findings: [],
      dropped: [],
      explored: {
        filesRead: [],
        searches: [],
      },
      stats: {
        durationMs: 5_000,
        toolCalls: 1,
      },
    });
    expect(out.text).toBe(
      "✅ All good\n\nWhat we looked at\n-----------------\n\nNothing recorded.\n",
    );
  });

  test("colors the review only when asked to", async () => {
    const result = {
      summary: "",
      findings: [],
      dropped: [],
      explored: {
        filesRead: [],
        searches: [],
      },
      stats: {
        durationMs: 5_000,
        toolCalls: 1,
      },
    };
    const plain = new BufferSink();
    const colored = new BufferSink();

    await new ConsoleReporter(plain, new BufferSink()).completed(result);
    await new ConsoleReporter(colored, new BufferSink(), {
      colors: true,
    }).completed(result);

    expect(plain.text).not.toContain("\u001B[");
    expect(colored.text).toContain("\u001B[");
  });
});
