import { describe, expect, test } from "bun:test";
import type { ReviewResult } from "../../review/findings";
import type { ReviewReporter, TextSink } from "../review-reporter";
import { JsonReporter } from "./json-reporter";

class BufferSink implements TextSink {
  text = "";

  write(text: string) {
    this.text += text;
  }
}

describe("JsonReporter", () => {
  test("writes only the result, as one JSON object", async () => {
    const out = new BufferSink();
    const reporter: ReviewReporter = new JsonReporter(out);
    const result: ReviewResult = {
      summary: "",
      findings: [
        {
          file: "a.ts",
          startLine: 4,
          endLine: 6,
          severity: "high",
          scope: "introduced",
          title: "Crashes on an empty list",
          explanation: "`items[0]` is undefined when `items` is [].",
        },
      ],
      dropped: [
        {
          finding: {
            file: "b.ts",
            startLine: 1,
            endLine: 1,
            severity: "nit",
            scope: "introduced",
            title: "`n` could be `count`",
            explanation: "Says what it counts.",
          },
          reason: "The name is already clear.",
        },
      ],
      explored: {
        filesRead: ["a.ts"],
        searches: [
          {
            pattern: "items",
            path: "src",
          },
        ],
      },
      stats: {
        durationMs: 5_000,
        toolCalls: 1,
        costUsd: 0.42,
      },
    };

    await reporter.started();
    reporter.toolCall("read", '{"path":"a.ts"}');
    reporter.thinking(2_400);
    await reporter.verifying(2);
    await reporter.completed(result);

    expect(JSON.parse(out.text)).toEqual({
      ...result,
      warnings: [],
    });
  });

  test("includes warnings in the result", async () => {
    const out = new BufferSink();
    const reporter: ReviewReporter = new JsonReporter(out);

    await reporter.warning("This change is large.");
    expect(out.text).toBe("");
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

    expect(JSON.parse(out.text)).toMatchObject({
      warnings: ["This change is large."],
    });
  });
});
