import { describe, expect, test } from "bun:test";
import type { PullRequestData } from "@/context/github/pull-request-data";
import type { ReviewContext } from "@/context/review-context-collector";
import {
  FINDER_LENSES,
  ReviewPromptBuilder,
} from "@/prompt/review-prompt-builder";

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

const context: ReviewContext = {
  repoRoot: "/repo",
  branch: "feature",
  base: "main",
  mergeBase: "abc123",
  commits: [],
  changedFiles: [],
  diff: "+change",
  pullRequest: {
    data: pullRequest,
    changedFilesWithSha: [],
  },
};

const DESCRIPTION_CHECK = "Check the PR description against the diff.";

describe("ReviewPromptBuilder.buildFinders", () => {
  const builder = new ReviewPromptBuilder();

  test("runs one generalist when asked for a single finder", () => {
    expect(builder.buildFinders(context, "x", 1)).toEqual([
      builder.build(context, "x"),
    ]);
  });

  test("gives each finder its own lens on the same context and request", () => {
    const prompts = builder.buildFinders(context, "x", FINDER_LENSES.length);

    expect(prompts).toHaveLength(FINDER_LENSES.length);
    prompts.forEach((prompt, index) => {
      expect(prompt.instructions).toContain(
        `Yours is ${FINDER_LENSES[index]?.name}:`,
      );
      expect(prompt.content).toEqual(builder.build(context, "x").content);
    });
  });

  test("checks the description in the first finder only", () => {
    const prompts = builder.buildFinders(context, "x", 3);

    expect(
      prompts.map((prompt) => {
        return prompt.instructions.includes(DESCRIPTION_CHECK);
      }),
    ).toEqual([true, false, false]);
  });
});
