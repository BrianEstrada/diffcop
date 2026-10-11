import { describe, expect, test } from "bun:test";
import type {
  PullRequestData,
  PullRequestSource,
} from "@/context/github/pull-request-data";
import type { ChangedFile, Repository } from "@/context/repository";
import { ReviewContextCollector } from "@/context/review-context-collector";

class FakeRepository implements Repository {
  async root() {
    return "/repo";
  }
  readonly mergeBaseCalls: string[] = [];
  readonly #knownRefs: string[];

  constructor(knownRefs: string[]) {
    this.#knownRefs = knownRefs;
  }

  async defaultBase() {
    return "origin/main";
  }

  async mergeBase(ref: string) {
    this.mergeBaseCalls.push(ref);
    if (!this.#knownRefs.includes(ref)) {
      throw new Error(`unknown ref ${ref}`);
    }
    return "abc123";
  }

  async currentBranch() {
    return "feature";
  }

  async commitsSince(ref: string) {
    return [`def456 commit after ${ref}`];
  }

  async changedFilesSince(): Promise<ChangedFile[]> {
    return [
      {
        path: "a.ts",
        additions: 2,
        deletions: 1,
      },
    ];
  }

  async diffSince(ref: string) {
    return `diff against ${ref}`;
  }

  async hashObject(path: string) {
    if (path === "unreadable.ts") {
      throw new Error("no such file");
    }
    return `sha-of-${path}`;
  }
}

const pullRequest: PullRequestData = {
  repo: "owner/repo",
  number: 7,
  action: "synchronize",
  title: "Add a thing",
  body: "Why",
  author: { login: "octocat" },
  headRefName: "feature",
  baseRefName: "main",
  state: "OPEN",
  additions: 4,
  deletions: 1,
  labels: { nodes: [] },
  commits: { totalCount: 2 },
  files: {
    totalCount: 3,
    nodes: [
      {
        path: "a.ts",
        additions: 2,
        deletions: 1,
        changeType: "MODIFIED",
      },
      {
        path: "gone.ts",
        additions: 0,
        deletions: 5,
        changeType: "DELETED",
      },
      {
        path: "unreadable.ts",
        additions: 1,
        deletions: 0,
        changeType: "ADDED",
      },
    ],
  },
  comments: { nodes: [] },
  reviews: { nodes: [] },
};

function source(data: PullRequestData): PullRequestSource {
  return {
    fetch: async () => {
      return data;
    },
  };
}

describe("ReviewContextCollector", () => {
  test("uses the repository's default base when none is given", async () => {
    const repository = new FakeRepository(["origin/main"]);
    const context = await new ReviewContextCollector(repository).collect();

    expect(repository.mergeBaseCalls).toEqual(["origin/main"]);
    expect(context).toEqual({
      repoRoot: "/repo",
      branch: "feature",
      base: "origin/main",
      mergeBase: "abc123",
      commits: ["def456 commit after abc123"],
      changedFiles: [
        {
          path: "a.ts",
          additions: 2,
          deletions: 1,
        },
      ],
      diff: "diff against abc123",
    });
  });

  test("uses an explicit base ref", async () => {
    const repository = new FakeRepository(["develop"]);
    const context = await new ReviewContextCollector(repository).collect(
      "develop",
    );

    expect(repository.mergeBaseCalls).toEqual(["develop"]);
    expect(context.base).toBe("develop");
  });

  test("surfaces a repository error before resolving the base", async () => {
    const repository = new FakeRepository(["origin/main"]);
    repository.root = async () => {
      throw new Error("Not a git repository: /nowhere");
    };

    expect(new ReviewContextCollector(repository).collect()).rejects.toThrow(
      "Not a git repository: /nowhere",
    );
    expect(repository.mergeBaseCalls).toEqual([]);
  });

  test("explains a missing merge base", async () => {
    const collector = new ReviewContextCollector(new FakeRepository([]));

    expect(collector.collect("gone")).rejects.toThrow(
      "Cannot find a merge base between HEAD and 'gone'. Pass --base.",
    );
  });

  test("leaves out PR data without a source", async () => {
    const context = await new ReviewContextCollector(
      new FakeRepository(["origin/main"]),
    ).collect();
    expect(context.pullRequest).toBeUndefined();
  });

  test("adds the PR data with each changed file's SHA", async () => {
    const context = await new ReviewContextCollector(
      new FakeRepository(["origin/main"]),
      source(pullRequest),
    ).collect();
    expect(context.pullRequest?.data).toBe(pullRequest);
    expect(
      context.pullRequest?.changedFilesWithSha.map((file) => {
        return [file.path, file.sha];
      }),
    ).toEqual([
      ["a.ts", "sha-of-a.ts"],
      ["gone.ts", "deleted"],
      ["unreadable.ts", "unknown"],
    ]);
  });

  test("diffs against the PR's current base from GitHub", async () => {
    const repository = new FakeRepository(["origin/main", "origin/stacked"]);
    const context = await new ReviewContextCollector(
      repository,
      source({
        ...pullRequest,
        baseRefName: "stacked",
      }),
    ).collect();
    expect(context.base).toBe("origin/stacked");
    expect(repository.mergeBaseCalls).toEqual(["origin/stacked"]);
  });

  test("prefers an explicit base over the PR's", async () => {
    const context = await new ReviewContextCollector(
      new FakeRepository(["origin/main", "origin/release"]),
      source({
        ...pullRequest,
        baseRefName: "stacked",
      }),
    ).collect("origin/release");
    expect(context.base).toBe("origin/release");
  });

  test("has no changed files when GitHub doesn't list them", async () => {
    const context = await new ReviewContextCollector(
      new FakeRepository(["origin/main"]),
      source({
        ...pullRequest,
        files: null,
      }),
    ).collect();
    expect(context.pullRequest?.changedFilesWithSha).toEqual([]);
  });
});
