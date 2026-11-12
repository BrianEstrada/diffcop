import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import type { ReviewResult } from "@/review/findings";
import type { ReviewReporter, TextSink } from "@/reporter/review-reporter";
import { GitHubClient } from "@/github/github-client";
import type { StatusUpdate } from "@/reporter/github/commit-status";
import { GitHubReporter } from "@/reporter/github/github-reporter";
import type { GitHubReporterOptions } from "@/reporter/github/github-reporter";
import { ReviewCommentFormatter } from "@/reporter/github/review-comment-formatter";
import { ReviewComments } from "@/reporter/github/review-comments";

const pr: PullRequestContext = {
  apiUrl: "https://api.github.test",
  repo: "owner/repo",
  number: 7,
  headSha: "abc1234def",
  title: "Title",
  body: "",
  runId: "42",
};

const EARLIER_COMMIT = "0000000aaa";

class BufferSink implements TextSink {
  text = "";

  write(text: string) {
    this.text += text;
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const EARLIER_URL = "https://github.test/owner/repo/pull/7#issuecomment-500";
const NEW_URL = "https://github.test/owner/repo/pull/7#issuecomment-900";

const commentWrite = z.object({ body: z.string() });

const graphqlCall = z.object({
  query: z.string(),
  variables: z
    .object({
      id: z.string().optional(),
      ids: z.array(z.string()).optional(),
    })
    .optional(),
});

interface Write {
  method: string;
  body: string;
}

// The PR starts with one diffcop comment: run `claimedBy`'s review of `reviewed`.
function fakeGitHub({
  claimedBy = "41",
  reviewed = EARLIER_COMMIT,
  failWrites = false,
  failLists = false,
  failHides = false,
} = {}) {
  const writes: Write[] = [];
  const hidden: string[] = [];
  const comments = [
    {
      id: 500,
      node_id: "C500",
      html_url: EARLIER_URL,
      user: { login: "github-actions[bot]" },
      body: `<!-- diffcop:review -->\n<!-- diffcop:run=${claimedBy} -->\n<!-- diffcop:head=${reviewed} -->`,
    },
  ];
  async function graphql(url: string, init?: RequestInit) {
    const { query, variables } = graphqlCall.parse(
      await new Request(url, init).json(),
    );
    if (query.includes("viewer")) {
      return Response.json({
        data: { viewer: { login: "github-actions[bot]" } },
      });
    }
    if (query.includes("minimizeComment")) {
      if (failHides) {
        return Response.json({ errors: [{ message: "Not allowed" }] });
      }
      hidden.push(variables?.id ?? "");
      return Response.json({ data: { minimizeComment: {} } });
    }
    const nodes = (variables?.ids ?? []).map((id) => {
      return {
        id: id,
        isMinimized: false,
      };
    });
    return Response.json({ data: { nodes: nodes } });
  }
  async function fetch(url: string, init?: RequestInit) {
    if (url.endsWith("/graphql")) {
      return graphql(url, init);
    }
    const method = init?.method ?? "GET";
    if (method === "GET") {
      if (failLists) {
        return new Response("Bad gateway", { status: 502 });
      }
      return Response.json(comments);
    }
    const { body } = commentWrite.parse(await new Request(url, init).json());
    writes.push({
      method: method,
      body: body,
    });
    if (failWrites) {
      return new Response("Bad gateway", { status: 502 });
    }
    if (method === "POST") {
      const created = {
        id: 900,
        node_id: "C900",
        html_url: NEW_URL,
        user: { login: "github-actions[bot]" },
        body: body,
      };
      comments.push(created);
      return Response.json(created);
    }
    return Response.json({});
  }
  return {
    writes: writes,
    hidden: hidden,
    fetch: fetch,
  };
}

const result: ReviewResult = {
  summary: "",
  findings: [],
  dropped: [],
  explored: {
    filesRead: [],
    searches: [],
  },
  stats: {
    durationMs: 1_000,
    toolCalls: 0,
  },
};

function createReporter(
  fetch: Fetch,
  secrets: string[] = [],
  options: GitHubReporterOptions = {},
) {
  const log = new BufferSink();
  const statuses: StatusUpdate[] = [];
  const reporter: ReviewReporter = new GitHubReporter(
    new ReviewComments(
      pr,
      new GitHubClient({
        baseUrl: pr.apiUrl,
        request: { fetch: fetch },
        retry: { retryAfterBaseValue: 0 },
      }),
    ),
    new ReviewCommentFormatter(pr, { secrets: secrets }),
    {
      post: async (update) => {
        statuses.push(update);
      },
    },
    log,
    options,
  );
  return {
    reporter: reporter,
    log: log,
    statuses: statuses,
  };
}

describe("GitHubReporter", () => {
  test("started marks the commit as being reviewed and posts no comment", async () => {
    const { writes, fetch } = fakeGitHub();
    const { reporter, statuses, log } = createReporter(fetch);

    await reporter.started();

    expect(writes).toEqual([]);
    expect(statuses).toEqual([
      {
        state: "pending",
        description: "Reviewing…",
      },
    ]);
    expect(log.text).toBe("");
  });

  test("started leaves the status to a newer run", async () => {
    const { fetch } = fakeGitHub({ claimedBy: "43" });
    const { reporter, statuses } = createReporter(fetch);

    await reporter.started();

    expect(statuses).toEqual([]);
  });

  test("started still marks the commit when the comments can't be read", async () => {
    const { fetch } = fakeGitHub({ failLists: true });
    const { reporter, statuses } = createReporter(fetch);

    await reporter.started();

    expect(statuses).toMatchObject([{ state: "pending" }]);
  });

  test("a warning waits for the review's comment", async () => {
    const { writes, fetch } = fakeGitHub();
    const { reporter, statuses } = createReporter(fetch);

    await reporter.started();
    await reporter.warning("This change is large.");
    expect(writes).toEqual([]);
    expect(statuses).toHaveLength(1);

    await reporter.completed(result);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toContain("> [!WARNING]\n> This change is large.");
    expect(writes[0]?.body).toContain("✅ **All good**");
  });

  test("logs the verification phase", async () => {
    const { fetch } = fakeGitHub();
    const { reporter, log } = createReporter(fetch);

    await reporter.verifying(1);

    expect(log.text).toBe("› verifying 1 finding…\n");
  });

  test("logs nothing while the review streams", () => {
    const { fetch } = fakeGitHub();
    const { reporter, log } = createReporter(fetch);

    reporter.toolCall("read", '{"path":"a.ts"}');
    reporter.thinking(2_400);

    expect(log.text).toBe("");
  });

  test("logs tool calls and thinking time in debug mode", () => {
    const { fetch } = fakeGitHub();
    const { reporter, log } = createReporter(fetch, [], { debug: true });

    reporter.toolCall("read", '{"path":"a.ts"}');
    reporter.thinking(2_400);

    expect(log.text).toBe('› read {"path":"a.ts"}\n› thinking (2s)\n');
  });

  test("completed posts a new commit's review as a new comment and hides the earlier one", async () => {
    const { writes, hidden, fetch } = fakeGitHub();
    const { reporter, statuses, log } = createReporter(fetch);

    await reporter.completed(result);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("POST");
    expect(writes[0]?.body).toContain("✅ **All good**");
    expect(hidden).toEqual(["C500"]);
    expect(statuses).toEqual([
      {
        state: "success",
        description: "All good",
        url: NEW_URL,
      },
    ]);
    expect(log.text).toBe(
      "Wrote the diffcop comment on owner/repo#7\nHid 1 earlier diffcop comment as outdated\n",
    );
  });

  test("completed edits the comment of a commit it reviewed before", async () => {
    const { writes, hidden, fetch } = fakeGitHub({ reviewed: pr.headSha });
    const { reporter, statuses } = createReporter(fetch);

    await reporter.completed(result);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("PATCH");
    expect(hidden).toEqual([]);
    expect(statuses).toMatchObject([{ url: EARLIER_URL }]);
  });

  test("completed fails the commit when the review found an issue", async () => {
    const { fetch } = fakeGitHub();
    const { reporter, statuses } = createReporter(fetch);

    await reporter.completed({
      ...result,
      findings: [
        {
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          severity: "high",
          scope: "introduced",
          title: "Drops the last page",
          explanation: "Off by one.",
        },
      ],
    });

    expect(statuses).toMatchObject([
      {
        state: "failure",
        description: "1 issue found",
      },
    ]);
  });

  test("completed throws when the post fails", async () => {
    const { fetch } = fakeGitHub({ failWrites: true });
    const { reporter } = createReporter(fetch);

    expect(reporter.completed(result)).rejects.toThrow("502 Bad gateway");
  });

  test("completed leaves the PR to a newer run", async () => {
    const { writes, hidden, fetch } = fakeGitHub({ claimedBy: "43" });
    const { reporter, statuses, log } = createReporter(fetch);

    await reporter.completed(result);

    expect(writes).toEqual([]);
    expect(hidden).toEqual([]);
    expect(statuses).toEqual([]);
    expect(log.text).toContain("A newer run has taken over");
  });

  test("completed still passes the commit when the earlier comment can't be hidden", async () => {
    const { fetch } = fakeGitHub({ failHides: true });
    const { reporter, statuses, log } = createReporter(fetch);

    await reporter.completed(result);

    expect(statuses).toMatchObject([{ state: "success" }]);
    expect(log.text).toContain("Couldn't hide the earlier diffcop comments:");
  });

  test("failed posts the error, redacted, and marks the commit as errored", async () => {
    const { writes, hidden, fetch } = fakeGitHub();
    const { reporter, statuses } = createReporter(fetch, [
      "sk-secret",
      "ghs_secret",
    ]);

    await reporter.failed(new Error("401 for sk-secret, then ghs_secret"), {
      cancelled: false,
    });

    expect(writes[0]?.body).toContain("401 for ***, then ***");
    expect(hidden).toEqual([]);
    expect(statuses).toEqual([
      {
        state: "error",
        description: "The review failed",
      },
    ]);
  });

  test("failed warns instead of throwing when the post fails", async () => {
    const { fetch } = fakeGitHub({ failWrites: true });
    const { reporter, statuses, log } = createReporter(fetch);

    await reporter.failed(new Error("boom"), { cancelled: false });

    expect(log.text).toStartWith("Couldn't post the diffcop comment:");
    expect(statuses).toMatchObject([{ state: "error" }]);
  });

  test("a cancelled review posts no comment, only the status", async () => {
    const { writes, fetch } = fakeGitHub();
    const { reporter, statuses } = createReporter(fetch);

    await reporter.failed(new Error("aborted"), { cancelled: true });

    expect(writes).toEqual([]);
    expect(statuses).toEqual([
      {
        state: "error",
        description: "The review was cancelled",
      },
    ]);
  });

  test("failed leaves the PR to a newer run", async () => {
    const { writes, fetch } = fakeGitHub({ claimedBy: "43" });
    const { reporter, statuses } = createReporter(fetch);

    await reporter.failed(new Error("boom"), { cancelled: false });
    await reporter.failed(new Error("aborted"), { cancelled: true });

    expect(writes).toEqual([]);
    expect(statuses).toEqual([]);
  });
});
