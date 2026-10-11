import { describe, expect, test } from "bun:test";
import type { JSONType } from "@/util/json";
import {
  ExplorationLog,
  explorationCall,
  mergeExplored,
} from "@/agent/explored";

function call(toolName: string, input: JSONType) {
  return explorationCall.parse({
    toolName: toolName,
    input: input,
  });
}

describe("ExplorationLog", () => {
  test("records files read relative to the cwd, once each, in first-seen order", () => {
    const log = new ExplorationLog("/repo");
    log.record(call("read", { file_path: "/repo/src/b.ts" }));
    log.record(
      call("read", {
        file_path: "/repo/src/a.ts",
        offset: 10,
        limit: 20,
      }),
    );
    log.record(call("read", { file_path: "src/b.ts" }));
    log.record(call("read", { file_path: "/elsewhere/c.ts" }));
    expect(log.explored().filesRead).toEqual([
      "src/b.ts",
      "src/a.ts",
      "../elsewhere/c.ts",
    ]);
  });

  test("records grep and glob searches with their path relative to the cwd", () => {
    const log = new ExplorationLog("/repo");
    log.record(
      call("grep", {
        pattern: "sumStats",
        path: "/repo/src",
        output_mode: "content",
      }),
    );
    log.record(call("glob", { pattern: "**/*.test.ts" }));
    log.record(
      call("grep", {
        pattern: "costUsd",
        path: "/repo",
      }),
    );
    log.record(
      call("grep", {
        pattern: "sumStats",
        path: "src",
      }),
    );
    expect(log.explored().searches).toEqual([
      {
        pattern: "sumStats",
        path: "src",
      },
      { pattern: "**/*.test.ts" },
      { pattern: "costUsd" },
    ]);
  });
});

describe("explorationCall", () => {
  test("rejects other tools and inputs it doesn't recognize", () => {
    const calls: [string, unknown][] = [
      ["read", { path: "/repo/a.ts" }],
      ["read", "a.ts"],
      ["grep", { query: "x" }],
      [
        "glob",
        {
          pattern: 1,
          path: "/repo",
        },
      ],
      ["bash", { command: "cat a.ts" }],
      ["webSearch", { query: "x" }],
    ];
    for (const [toolName, input] of calls) {
      expect(
        explorationCall.safeParse({
          toolName: toolName,
          input: input,
        }).success,
      ).toBe(false);
    }
  });
});

describe("mergeExplored", () => {
  test("keeps the first pass's order and adds only what's new from the second", () => {
    expect(
      mergeExplored(
        {
          filesRead: ["a.ts", "b.ts"],
          searches: [{ pattern: "x" }],
        },
        {
          filesRead: ["b.ts", "c.ts"],
          searches: [
            {
              pattern: "x",
              path: "src",
            },
            { pattern: "x" },
          ],
        },
      ),
    ).toEqual({
      filesRead: ["a.ts", "b.ts", "c.ts"],
      searches: [
        { pattern: "x" },
        {
          pattern: "x",
          path: "src",
        },
      ],
    });
  });
});
