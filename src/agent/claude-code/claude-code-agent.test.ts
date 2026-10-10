import { describe, expect, test } from "bun:test";
import {
  approvalRequestError,
  costFrom,
  REVIEWER_TOOLS,
} from "./claude-code-agent";

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

describe("costFrom", () => {
  test("reads Claude Code's cost estimate from the finish part", () => {
    expect(
      costFrom({
        type: "finish",
        providerMetadata: { "claude-code": { costUsd: 0.42 } },
      }),
    ).toBe(0.42);
  });

  test("is undefined when the finish part has no usable cost", () => {
    expect(costFrom({ type: "finish" })).toBeUndefined();
    expect(
      costFrom({
        type: "finish",
        providerMetadata: { "claude-code": {} },
      }),
    ).toBeUndefined();
    expect(
      costFrom({
        type: "finish",
        providerMetadata: { "claude-code": { costUsd: "0.42" } },
      }),
    ).toBeUndefined();
  });
});
