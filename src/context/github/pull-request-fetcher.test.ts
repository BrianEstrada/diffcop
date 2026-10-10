import { describe, expect, test } from "bun:test";
import { GitHubClient } from "../../github/github-client";
import type { PullRequestContext } from "./pull-request-context";
import { PullRequestFetcher } from "./pull-request-fetcher";

const pr: PullRequestContext = {
  apiUrl: "https://api.github.test",
  repo: "owner/repo",
  number: 7,
  headSha: "abc1234def",
  title: "Title from the event",
  body: "Body from the event",
  action: "synchronize",
  triggerTime: "2026-10-02T10:00:00Z",
};

const BEFORE = "2026-10-02T09:00:00Z";
const AFTER = "2026-10-02T11:00:00Z";

function comment(body: string, createdAt: string, updatedAt = createdAt) {
  return {
    body: body,
    author: { login: "octocat" },
    createdAt: createdAt,
    updatedAt: updatedAt,
    lastEditedAt: null,
    isMinimized: false,
  };
}

const pullRequest = {
  title: "Title edited later",
  body: "Body edited later",
  author: { login: "octocat" },
  baseRefName: "main",
  headRefName: "feature",
  additions: 4,
  deletions: 1,
  state: "OPEN",
  labels: { nodes: [{ name: "bug" }] },
  commits: { totalCount: 2 },
  files: {
    totalCount: 0,
    nodes: [],
  },
  comments: {
    nodes: [
      comment("kept", BEFORE),
      comment("posted after the push", AFTER),
      comment("edited after the push", BEFORE, AFTER),
    ],
  },
  reviews: {
    nodes: [
      {
        author: { login: "reviewer" },
        body: "kept review",
        state: "COMMENTED",
        submittedAt: BEFORE,
        updatedAt: BEFORE,
        lastEditedAt: null,
        comments: {
          nodes: [
            {
              ...comment("kept inline", BEFORE),
              path: "a.ts",
              line: 3,
              diffHunk: "@@ -1 +1 @@",
            },
            {
              ...comment("inline edited after", BEFORE, AFTER),
              path: "a.ts",
              line: 4,
              diffHunk: "@@ -1 +1 @@",
            },
          ],
        },
      },
      {
        author: { login: "reviewer" },
        body: "review after the push",
        state: "COMMENTED",
        submittedAt: AFTER,
        updatedAt: AFTER,
        lastEditedAt: null,
        comments: { nodes: [] },
      },
    ],
  },
};

function fakeGraphQL(data: unknown) {
  const requests: { url: string; body: unknown }[] = [];
  async function fetch(url: string, init?: RequestInit) {
    requests.push({
      url: url,
      body: await new Request(url, init).json(),
    });
    return Response.json({ data: data });
  }
  return {
    requests: requests,
    fetcher: new PullRequestFetcher(
      pr,
      new GitHubClient({
        auth: "t",
        baseUrl: pr.apiUrl,
        request: { fetch: fetch },
      }),
    ),
  };
}

describe("PullRequestFetcher", () => {
  test("queries the PR by owner, repo and number", async () => {
    const { requests, fetcher } = fakeGraphQL({
      repository: { pullRequest: pullRequest },
    });
    await fetcher.fetch();
    expect(requests[0]).toMatchObject({
      url: "https://api.github.test/graphql",
      body: {
        variables: {
          owner: "owner",
          repo: "repo",
          number: 7,
        },
      },
    });
  });

  test("takes the title and body from the event, not the API", async () => {
    const { fetcher } = fakeGraphQL({
      repository: { pullRequest: pullRequest },
    });
    const data = await fetcher.fetch();
    expect(data).toMatchObject({
      repo: "owner/repo",
      number: 7,
      action: "synchronize",
      title: "Title from the event",
      body: "Body from the event",
    });
  });

  test("leaves out comments and reviews created or edited from the trigger on", async () => {
    const { fetcher } = fakeGraphQL({
      repository: { pullRequest: pullRequest },
    });
    const data = await fetcher.fetch();
    expect(
      data.comments.nodes.map((c) => {
        return c.body;
      }),
    ).toEqual(["kept"]);
    expect(
      data.reviews.nodes.map((r) => {
        return r.body;
      }),
    ).toEqual(["kept review"]);
    expect(
      data.reviews.nodes[0]?.comments.nodes.map((c) => {
        return c.body;
      }),
    ).toEqual(["kept inline"]);
  });

  test("throws when the PR isn't found", async () => {
    const { fetcher } = fakeGraphQL({ repository: { pullRequest: null } });
    expect(fetcher.fetch()).rejects.toThrow(
      "Pull request owner/repo#7 not found.",
    );
  });

  test("throws when the response doesn't match the query", async () => {
    const { fetcher } = fakeGraphQL({
      repository: {
        pullRequest: {
          ...pullRequest,
          labels: null,
        },
      },
    });
    expect(fetcher.fetch()).rejects.toThrow("repository.pullRequest.labels");
  });
});
