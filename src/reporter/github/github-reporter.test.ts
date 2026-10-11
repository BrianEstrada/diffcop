import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import type { ReviewResult } from "@/review/findings";
import type { ReviewReporter, TextSink } from "@/reporter/review-reporter";
import { GitHubClient } from "@/github/github-client";
import { GitHubReporter } from "@/reporter/github/github-reporter";
import type { GitHubReporterOptions } from "@/reporter/github/github-reporter";
import { ReviewCommentFormatter } from "@/reporter/github/review-comment-formatter";
import { StickyComment } from "@/reporter/github/sticky-comment";

const pr: PullRequestContext = {
  apiUrl: "https://api.github.test",
  repo: "owner/repo",
  number: 7,
  headSha: "abc1234def",
  title: "Title",
  body: "",
  runId: "42",
};

class BufferSink implements TextSink {
  text = "";

  write(text: string) {
    this.text += text;
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const commentWrite = z.object({ body: z.string() });

function fakeGitHub({ claimedBy = "41", failWrites = false } = {}) {
  const writes: string[] = [];
  async function fetch(url: string, init?: RequestInit) {
    if (url.endsWith("/graphql")) {
      return Response.json({
        data: { viewer: { login: "github-actions[bot]" } },
      });
    }
    if (!init?.body) {
      return Response.json([
        {
          id: 500,
          user: { login: "github-actions[bot]" },
          body: `<!-- diffcop:review -->\n<!-- diffcop:run=${claimedBy} -->`,
        },
      ]);
    }
    writes.push(commentWrite.parse(await new Request(url, init).json()).body);
    if (failWrites) {
      return new Response("Bad gateway", { status: 502 });
    }
    return Response.json({});
  }
  return {
    writes: writes,
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
  const reporter: ReviewReporter = new GitHubReporter(
    new StickyComment(
      pr,
      new GitHubClient({
        baseUrl: pr.apiUrl,
        request: { fetch: fetch },
        retry: { retryAfterBaseValue: 0 },
      }),
    ),
    new ReviewCommentFormatter(pr, { secrets: secrets }),
    log,
    options,
  );
  return {
    reporter: reporter,
    log: log,
  };
}

describe("GitHubReporter", () => {
  test("started posts the running status", async () => {
    const { writes, fetch } = fakeGitHub();
    const { reporter, log } = createReporter(fetch);

    await reporter.started();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("⏳ Reviewing `abc1234`");
    expect(log.text).toBe("Updated the diffcop comment on owner/repo#7\n");
  });

  test("started warns instead of throwing when the post fails", async () => {
    const { fetch } = fakeGitHub({ failWrites: true });
    const { reporter, log } = createReporter(fetch);

    await reporter.started();

    expect(log.text).toStartWith("Couldn't update the diffcop comment:");
    expect(log.text).toContain("502 Bad gateway");
  });

  test("started leaves a comment claimed by a newer run alone", async () => {
    const { writes, fetch } = fakeGitHub({ claimedBy: "43" });
    const { reporter, log } = createReporter(fetch);

    await reporter.started();

    expect(writes).toHaveLength(0);
    expect(log.text).toContain("A newer run has taken over");
  });

  test("warning re-posts the running status with the warning on top", async () => {
    const { writes, fetch } = fakeGitHub();
    const { reporter } = createReporter(fetch);

    await reporter.started();
    await reporter.warning("This change is large.");
    await reporter.completed(result);

    expect(writes).toHaveLength(3);
    expect(writes[0]).not.toContain("[!WARNING]");
    expect(writes[1]).toContain("> [!WARNING]\n> This change is large.");
    expect(writes[1]).toContain("⏳ Reviewing `abc1234`");
    expect(writes[2]).toContain("> [!WARNING]\n> This change is large.");
    expect(writes[2]).toContain("✅ **All good**");
  });

  test("warning warns instead of throwing when the post fails", async () => {
    const { fetch } = fakeGitHub({ failWrites: true });
    const { reporter, log } = createReporter(fetch);

    await reporter.warning("This change is large.");

    expect(log.text).toStartWith("Couldn't update the diffcop comment:");
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

  test("completed posts the review", async () => {
    const { writes, fetch } = fakeGitHub();
    const { reporter } = createReporter(fetch);

    await reporter.completed(result);

    expect(writes[0]).toContain("✅ **All good**");
  });

  test("completed throws when the post fails", async () => {
    const { fetch } = fakeGitHub({ failWrites: true });
    const { reporter } = createReporter(fetch);

    expect(reporter.completed(result)).rejects.toThrow("502 Bad gateway");
  });

  test("completed leaves a comment claimed by a newer run alone", async () => {
    const { writes, fetch } = fakeGitHub({ claimedBy: "43" });
    const { reporter, log } = createReporter(fetch);

    await reporter.completed(result);

    expect(writes).toHaveLength(0);
    expect(log.text).toContain("A newer run has taken over");
  });

  test("failed redacts credentials from the posted error", async () => {
    const { writes, fetch } = fakeGitHub();
    const { reporter } = createReporter(fetch, ["sk-secret", "ghs_secret"]);

    await reporter.failed(new Error("401 for sk-secret, then ghs_secret"), {
      cancelled: false,
    });

    expect(writes[0]).toContain("401 for ***, then ***");
  });

  test("failed warns instead of throwing when the post fails", async () => {
    const { fetch } = fakeGitHub({ failWrites: true });
    const { reporter, log } = createReporter(fetch);

    await reporter.failed(new Error("boom"), { cancelled: false });

    expect(log.text).toStartWith("Couldn't update the diffcop comment:");
  });
});
