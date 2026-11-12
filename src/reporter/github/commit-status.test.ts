import { describe, expect, test } from "bun:test";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import { GitHubClient } from "@/github/github-client";
import {
  CommitStatus,
  failureStatus,
  reviewStatus,
} from "@/reporter/github/commit-status";
import type { TextSink } from "@/reporter/review-reporter";
import type { Finding } from "@/review/findings";

const pr: PullRequestContext = {
  apiUrl: "https://api.github.test",
  repo: "owner/repo",
  number: 7,
  headSha: "abc1234def",
  title: "Title",
  body: "",
  runUrl: "https://github.test/owner/repo/actions/runs/42",
};

class BufferSink implements TextSink {
  text = "";

  write(text: string) {
    this.text += text;
  }
}

interface Call {
  url: string;
  body: unknown;
}

function createStatus(respond: () => Response, context = pr) {
  const calls: Call[] = [];
  const log = new BufferSink();
  async function fetch(url: string, init?: RequestInit) {
    calls.push({
      url: url,
      body: await new Request(url, init).json(),
    });
    return respond();
  }
  const status = new CommitStatus(
    context,
    new GitHubClient({
      baseUrl: context.apiUrl,
      request: { fetch: fetch },
      retry: { retryAfterBaseValue: 0 },
    }),
    log,
  );
  return {
    status: status,
    calls: calls,
    log: log,
  };
}

function created() {
  return Response.json({}, { status: 201 });
}

function finding(overrides: Partial<Finding>): Finding {
  return {
    file: "a.ts",
    startLine: 1,
    endLine: 1,
    severity: "high",
    scope: "introduced",
    title: "Drops the last page",
    explanation: "Off by one.",
    ...overrides,
  };
}

describe("CommitStatus", () => {
  test("posts the status on the PR's head commit, linking to the run", async () => {
    const { status, calls } = createStatus(created);

    await status.post({
      state: "pending",
      description: "Reviewing…",
    });

    expect(calls).toEqual([
      {
        url: "https://api.github.test/repos/owner/repo/statuses/abc1234def",
        body: {
          state: "pending",
          context: "diffcop",
          description: "Reviewing…",
          target_url: "https://github.test/owner/repo/actions/runs/42",
        },
      },
    ]);
  });

  test("links to the given page instead of the run", async () => {
    const { status, calls } = createStatus(created);

    await status.post({
      state: "success",
      description: "All good",
      url: "https://github.test/owner/repo/pull/7#issuecomment-500",
    });

    expect(calls[0]?.body).toMatchObject({
      target_url: "https://github.test/owner/repo/pull/7#issuecomment-500",
    });
  });

  test("posts without a link outside a workflow run", async () => {
    const { status, calls } = createStatus(created, {
      ...pr,
      runUrl: undefined,
    });

    await status.post({
      state: "success",
      description: "All good",
    });

    expect(calls[0]?.body).toEqual({
      state: "success",
      context: "diffcop",
      description: "All good",
    });
  });

  test("cuts a description GitHub would reject", async () => {
    const { status, calls } = createStatus(created);

    await status.post({
      state: "error",
      description: "x".repeat(200),
    });

    expect(calls[0]?.body).toMatchObject({ description: "x".repeat(140) });
  });

  test("says once that the token can't post statuses, then stops trying", async () => {
    const { status, calls, log } = createStatus(() => {
      return Response.json(
        { message: "Resource not accessible by integration" },
        { status: 403 },
      );
    });

    await status.post({
      state: "pending",
      description: "Reviewing…",
    });
    await status.post({
      state: "success",
      description: "All good",
    });

    expect(calls).toHaveLength(1);
    expect(log.text).toBe(
      "Skipping the diffcop status: the token can't post one. The workflow's permissions need `statuses: write`.\n",
    );
  });

  test("keeps trying after a 403 that isn't about permissions", async () => {
    const { status, calls, log } = createStatus(() => {
      return Response.json(
        { message: "You have exceeded a secondary rate limit." },
        { status: 403 },
      );
    });

    await status.post({
      state: "pending",
      description: "Reviewing…",
    });
    await status.post({
      state: "success",
      description: "All good",
    });

    expect(calls).toHaveLength(2);
    expect(log.text).toContain("Couldn't post the diffcop status:");
    expect(log.text).not.toContain("statuses: write");
  });

  test("logs any other failure instead of throwing, and tries again next time", async () => {
    const { status, calls, log } = createStatus(() => {
      return Response.json({ message: "Validation failed" }, { status: 422 });
    });

    await status.post({
      state: "pending",
      description: "Reviewing…",
    });
    await status.post({
      state: "success",
      description: "All good",
    });

    expect(calls).toHaveLength(2);
    expect(log.text).toContain("Couldn't post the diffcop status:");
    expect(log.text).toContain("Validation failed");
  });
});

describe("reviewStatus", () => {
  test("passes a review with nothing to fix", () => {
    expect(reviewStatus({ findings: [] })).toMatchObject({
      state: "success",
      description: "All good",
    });
  });

  test("passes a review with only minor findings", () => {
    const findings = [
      finding({ severity: "nit" }),
      finding({ severity: "low" }),
    ];
    expect(reviewStatus({ findings: findings })).toMatchObject({
      state: "success",
      description: "2 minor findings",
    });
  });

  test("passes a review whose only finding was already wrong before the change", () => {
    const findings = [finding({ scope: "preexisting" })];
    expect(reviewStatus({ findings: findings }).state).toBe("success");
  });

  test("fails a review with an issue", () => {
    const findings = [finding({}), finding({ severity: "medium" })];
    expect(reviewStatus({ findings: findings })).toMatchObject({
      state: "failure",
      description: "2 issues found",
    });
  });

  test("fails a review whose description doesn't match the diff", () => {
    const findings = [finding({ scope: "description" })];
    expect(reviewStatus({ findings: findings })).toMatchObject({
      state: "failure",
      description: "Description doesn't match the diff",
    });
  });

  test("links to the page it was given", () => {
    expect(reviewStatus({ findings: [] }, "https://example.test").url).toBe(
      "https://example.test",
    );
  });
});

describe("failureStatus", () => {
  test("tells a cancelled review from a failed one", () => {
    expect(failureStatus(false)).toEqual({
      state: "error",
      description: "The review failed",
    });
    expect(failureStatus(true)).toEqual({
      state: "error",
      description: "The review was cancelled",
    });
  });
});
