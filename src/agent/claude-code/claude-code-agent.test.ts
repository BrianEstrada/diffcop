import { describe, expect, test } from "bun:test";
import {
  approvalRequestError,
  finishCost,
  REVIEWER_TOOLS,
} from "@/agent/claude-code/claude-code-agent";

describe("REVIEWER_TOOLS", () => {
  test("only grants read-only tools", () => {
    expect([...REVIEWER_TOOLS]).toEqual(["read", "glob", "grep"]);
  });
});

describe("approvalRequestError", () => {
  test("names the denied tool and the allowed ones", () => {
    expect(approvalRequestError("Bash").message).toBe(
      "The reviewer asked to use Bash, which needs an approval diffcop can't give. Only read, glob, grep are allowed.",
    );
  });
});

describe("finishCost", () => {
  test("reads Claude Code's cost estimate from the finish part", () => {
    expect(
      finishCost.safeParse({
        type: "finish",
        providerMetadata: { "claude-code": { costUsd: 0.42 } },
      }).data,
    ).toBe(0.42);
  });

  test("is undefined when the finish part has no usable cost", () => {
    expect(finishCost.safeParse({ type: "finish" }).data).toBeUndefined();
    expect(
      finishCost.safeParse({
        type: "finish",
        providerMetadata: { "claude-code": {} },
      }).data,
    ).toBeUndefined();
    expect(
      finishCost.safeParse({
        type: "finish",
        providerMetadata: { "claude-code": { costUsd: "0.42" } },
      }).data,
    ).toBeUndefined();
  });
});

describe("Claude Code bridge", () => {
  // patches/@ai-sdk%2Fharness-claude-code@*.patch: under "allow-reads" the bridge
  // defers any tool it doesn't know, and the harness then denies StructuredOutput.
  test("doesn't ask approval for StructuredOutput", async () => {
    const bridge = await Bun.file(
      new URL(
        "bridge/index.mjs",
        import.meta.resolve("@ai-sdk/harness-claude-code"),
      ),
    ).text();
    expect(bridge).toContain('StructuredOutput: "readonly",');
  });
});
