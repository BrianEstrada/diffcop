import { describe, expect, test } from "bun:test";
import { ExplorationLog, mergeExplored } from "./explored";

describe("ExplorationLog", () => {
  test("records files read relative to the cwd, once each, in first-seen order", () => {
    const log = new ExplorationLog("/repo");
    log.record("read", { file_path: "/repo/src/b.ts" });
    log.record("read", {
      file_path: "/repo/src/a.ts",
      offset: 10,
      limit: 20,
    });
    log.record("read", { file_path: "src/b.ts" });
    log.record("read", { file_path: "/elsewhere/c.ts" });
    expect(log.explored().filesRead).toEqual([
      "src/b.ts",
      "src/a.ts",
      "../elsewhere/c.ts",
    ]);
  });

  test("records grep and glob searches with their path relative to the cwd", () => {
    const log = new ExplorationLog("/repo");
    log.record("grep", {
      pattern: "sumStats",
      path: "/repo/src",
      output_mode: "content",
    });
    log.record("glob", { pattern: "**/*.test.ts" });
    log.record("grep", {
      pattern: "costUsd",
      path: "/repo",
    });
    log.record("grep", {
      pattern: "sumStats",
      path: "src",
    });
    expect(log.explored().searches).toEqual([
      {
        pattern: "sumStats",
        path: "src",
      },
      { pattern: "**/*.test.ts" },
      { pattern: "costUsd" },
    ]);
  });

  test("ignores other tools and inputs it doesn't recognize", () => {
    const log = new ExplorationLog("/repo");
    log.record("read", { path: "/repo/a.ts" });
    log.record("read", "a.ts");
    log.record("grep", { query: "x" });
    log.record("glob", {
      pattern: 1,
      path: "/repo",
    });
    log.record("bash", { command: "cat a.ts" });
    log.record("webSearch", { query: "x" });
    expect(log.explored()).toEqual({
      filesRead: [],
      searches: [],
    });
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
