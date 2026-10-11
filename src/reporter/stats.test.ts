import { describe, expect, test } from "bun:test";
import { formatDuration, formatStats } from "@/reporter/stats";

describe("formatDuration", () => {
  test("shows seconds under a minute and minutes after", () => {
    expect(formatDuration(42_400)).toBe("42s");
    expect(formatDuration(111_000)).toBe("1m 51s");
  });
});

describe("formatStats", () => {
  test("includes every stat that's known", () => {
    expect(
      formatStats({
        durationMs: 5_000,
        toolCalls: 1,
        inputTokens: 68_874,
        cacheReadTokens: 0,
        outputTokens: 19,
        costUsd: 0.2757,
      }),
    ).toBe("5s · 1 tool call · 68.9K input tokens · 19 output · ~$0.28");
  });

  test("shows the cached share of input tokens when some were cached", () => {
    expect(
      formatStats({
        durationMs: 5_000,
        toolCalls: 2,
        inputTokens: 200_000,
        cacheReadTokens: 189_100,
      }),
    ).toBe("5s · 2 tool calls · 200K input tokens (95% cached)");
  });

  test("leaves out stats the harness didn't report", () => {
    expect(
      formatStats({
        durationMs: 5_000,
        toolCalls: 0,
      }),
    ).toBe("5s · 0 tool calls");
  });
});
