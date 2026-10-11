import { describe, expect, test } from "bun:test";
import { sumStats } from "@/agent/reviewer-agent";

describe("sumStats", () => {
  test("adds up every stat both runs reported", () => {
    expect(
      sumStats(
        {
          durationMs: 1_000,
          toolCalls: 3,
          inputTokens: 100,
          cacheReadTokens: 50,
          outputTokens: 10,
          costUsd: 0.25,
        },
        {
          durationMs: 2_000,
          toolCalls: 4,
          inputTokens: 200,
          cacheReadTokens: 150,
          outputTokens: 20,
          costUsd: 0.5,
        },
      ),
    ).toEqual({
      durationMs: 3_000,
      toolCalls: 7,
      inputTokens: 300,
      cacheReadTokens: 200,
      outputTokens: 30,
      costUsd: 0.75,
    });
  });

  test("leaves out a stat only one run reported", () => {
    const sum = sumStats(
      {
        durationMs: 1_000,
        toolCalls: 0,
        costUsd: 0.25,
      },
      {
        durationMs: 1_000,
        toolCalls: 0,
        inputTokens: 200,
      },
    );
    expect(sum.costUsd).toBeUndefined();
    expect(sum.inputTokens).toBeUndefined();
  });
});
