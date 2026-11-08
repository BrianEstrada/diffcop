import { describe, expect, test } from "bun:test";
import type { PullRequestData } from "@/context/github/pull-request-data";
import type { ReviewContext } from "@/context/review-context-collector";
import { ReviewPromptBuilder } from "@/prompt/review-prompt-builder";
import { LINES_PER_CHUNK } from "@/review/diff-chunks";
import type { Finding, Scope } from "@/review/findings";

const pullRequest: PullRequestData = {
  repo: "owner/repo",
  number: 7,
  action: "opened",
  title: "Add a cache",
  body: "Adds a cache in front of the API.",
  author: { login: "octocat" },
  headRefName: "feature",
  baseRefName: "main",
  state: "OPEN",
  additions: 1,
  deletions: 0,
  labels: { nodes: [] },
  commits: { totalCount: 1 },
  files: null,
  comments: { nodes: [] },
  reviews: { nodes: [] },
};

function fileDiff(path: string) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${path} line\n`;
}

const context: ReviewContext = {
  repoRoot: "/repo",
  branch: "feature",
  base: "main",
  mergeBase: "abc123",
  commits: [],
  changedFiles: ["a/x.ts", "b/y.ts"].map((path) => {
    return {
      path: path,
      additions: LINES_PER_CHUNK,
      deletions: 0,
    };
  }),
  diff: fileDiff("a/x.ts") + fileDiff("b/y.ts"),
  pullRequest: {
    data: pullRequest,
    changedFilesWithSha: [],
  },
};

const DESCRIPTION_CHECK = "Check the PR description against the diff.";

describe("ReviewPromptBuilder.buildFinders", () => {
  const builder = new ReviewPromptBuilder();

  test("runs one generalist over the whole diff when the change fits one chunk", () => {
    const small: ReviewContext = {
      ...context,
      changedFiles: [
        {
          path: "a/x.ts",
          additions: 10,
          deletions: 0,
        },
      ],
    };

    expect(builder.buildFinders(small, "x", 6)).toEqual([
      { prompt: builder.build(small, "x") },
    ]);
  });

  test("gives each chunk's finder only its own files' diff", () => {
    const [first, second] = builder.buildFinders(context, "x", 6);

    expect(first?.files).toEqual(["a/x.ts"]);
    expect(first?.prompt.content[0]).toContain("+a/x.ts line");
    expect(first?.prompt.content[0]).not.toContain("+b/y.ts line");
    expect(first?.prompt.content[1]).toBe(
      "<assigned_files>\na/x.ts\n</assigned_files>",
    );
    expect(second?.prompt.content[0]).toContain("+b/y.ts line");
    expect(second?.prompt.content[0]).not.toContain("+a/x.ts line");
  });

  test("gives every chunk the whole diff when it can't be split by file", () => {
    const unsplittable: ReviewContext = {
      ...context,
      diff: "+change",
    };

    const prompts = builder.buildFinders(unsplittable, "x", 6);

    expect(prompts[0]?.prompt.content[0]).toContain("<diff>\n+change\n</diff>");
    expect(prompts[1]?.prompt.content[0]).toContain("<diff>\n+change\n</diff>");
  });

  test("reviews each chunk twice, files in opposite orders", () => {
    const sized: ReviewContext = {
      ...context,
      changedFiles: [
        {
          path: "a/x.ts",
          additions: 100,
          deletions: 0,
        },
        {
          path: "a/z.ts",
          additions: 100,
          deletions: 0,
        },
        {
          path: "b/y.ts",
          additions: LINES_PER_CHUNK,
          deletions: 0,
        },
      ],
      diff: fileDiff("a/x.ts") + fileDiff("a/z.ts") + fileDiff("b/y.ts"),
    };

    const prompts = builder.buildFinders(sized, "x", 6);

    expect(
      prompts.map(({ files }) => {
        return files;
      }),
    ).toEqual([
      ["a/x.ts", "a/z.ts"],
      ["b/y.ts"],
      ["a/z.ts", "a/x.ts"],
      ["b/y.ts"],
      undefined,
    ]);
    const reversed = prompts[2]?.prompt.content[0] ?? "";
    expect(reversed.indexOf("+a/z.ts line")).toBeLessThan(
      reversed.indexOf("+a/x.ts line"),
    );
  });

  test("adds one finder that reviews the whole diff and checks the description", () => {
    const prompts = builder.buildFinders(context, "x", 6);
    const whole = prompts.at(-1);

    expect(
      prompts.map(({ prompt }) => {
        return prompt.instructions.includes(DESCRIPTION_CHECK);
      }),
    ).toEqual([false, false, false, false, true]);
    expect(whole?.files).toBeUndefined();
    expect(whole?.prompt.instructions).toContain("Find as many real bugs");
    expect(whole?.prompt.content[0]).toContain("+a/x.ts line");
    expect(whole?.prompt.content[0]).toContain("+b/y.ts line");
  });

  test("reviews the whole diff without a description check outside a PR", () => {
    const local: ReviewContext = {
      ...context,
      pullRequest: undefined,
    };

    const prompts = builder.buildFinders(local, "x", 6);

    expect(prompts).toHaveLength(5);
    expect(prompts.at(-1)?.prompt.instructions).not.toContain(
      DESCRIPTION_CHECK,
    );
  });
});

describe("ReviewPromptBuilder.buildVerification", () => {
  const builder = new ReviewPromptBuilder();

  function at(file: string, scope: Scope = "introduced"): Finding {
    return {
      file: file,
      startLine: 1,
      endLine: 1,
      severity: "high",
      scope: scope,
      title: "Breaks",
      explanation: "Throws.",
    };
  }

  test("shows only the diff of the files the findings cite", () => {
    const prompt = builder.buildVerification(context, [at("a/x.ts")]);

    expect(prompt.content[0]).toContain("+a/x.ts line");
    expect(prompt.content[0]).not.toContain("+b/y.ts line");
    expect(prompt.instructions).toContain("only the changes to the files");
  });

  test("shows the whole diff for a finding in an unchanged file", () => {
    const prompt = builder.buildVerification(context, [at("c/other.ts")]);

    expect(prompt.content[0]).toContain("+a/x.ts line");
    expect(prompt.content[0]).toContain("+b/y.ts line");
    expect(prompt.instructions).not.toContain("only the changes to the files");
  });

  test("shows the whole diff for a description finding", () => {
    const prompt = builder.buildVerification(context, [
      at("a/x.ts", "description"),
    ]);

    expect(prompt.content[0]).toContain("+b/y.ts line");
  });
});
