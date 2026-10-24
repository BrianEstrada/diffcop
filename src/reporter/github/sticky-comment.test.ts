import { describe, expect, test } from "bun:test";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import { z } from "zod";
import { GitHubClient } from "@/github/github-client";
import { StickyComment } from "@/reporter/github/sticky-comment";

const pr: PullRequestContext = {
  apiUrl: "https://api.github.test",
  repo: "owner/repo",
  number: 7,
  headSha: "abc1234def",
  title: "Title",
  body: "",
};

const run: PullRequestContext = {
  ...pr,
  runId: "42",
};

// These markers are the format already on PRs, so changing them orphans
// existing comments.
function diffcopComment(runId?: string) {
  return [
    "<!-- diffcop:review -->",
    ...(runId ? [`<!-- diffcop:run=${runId} -->`] : []),
    "## diffcop review",
  ].join("\n");
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const BOT = "github-actions[bot]";

interface Comment {
  id: number;
  body: string;
  user?: { login: string };
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

const commentWrite = z.object({ body: z.string() });

async function writtenBody(url: string, init?: RequestInit) {
  if (!init?.body) {
    return undefined;
  }
  return commentWrite.parse(await new Request(url, init).json());
}

// `lostResponses` writes that GitHub applies but answers with a 502.
// Comments are the bot's unless they say otherwise.
function fakeGitHub(
  pages: Comment[][],
  { writeFailures = 0, lostResponses = 0 } = {},
) {
  const calls: Call[] = [];
  let failures = 0;
  let lost = 0;
  async function fetch(url: string, init?: RequestInit) {
    const method = init?.method ?? "GET";
    if (url.endsWith("/graphql")) {
      return Response.json({ data: { viewer: { login: BOT } } });
    }
    const body = await writtenBody(url, init);
    calls.push({
      method: method,
      url: url,
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: body,
    });
    if (method !== "GET") {
      if (failures < writeFailures) {
        failures++;
        return new Response("Bad gateway", { status: 502 });
      }
      if (method === "POST") {
        pages.at(-1)?.push({
          id: 900,
          body: body?.body ?? "",
        });
      }
      if (lost < lostResponses) {
        lost++;
        return new Response("Bad gateway", { status: 502 });
      }
      return Response.json({});
    }
    const next = new URL(url);
    const page = Number(next.searchParams.get("page") ?? 1);
    next.searchParams.set("page", String(page + 1));
    const comments = (pages[page - 1] ?? []).map((comment) => {
      return {
        user: { login: BOT },
        ...comment,
      };
    });
    return Response.json(comments, {
      headers:
        page < pages.length ? { link: `<${next.href}>; rel="next"` } : {},
    });
  }
  return {
    calls: calls,
    fetch: fetch,
  };
}

function sticky(pullRequest: PullRequestContext, fetch: Fetch) {
  return new StickyComment(
    pullRequest,
    new GitHubClient({
      auth: "t",
      baseUrl: pullRequest.apiUrl,
      request: { fetch: fetch },
      retry: { retryAfterBaseValue: 0 },
    }),
  );
}

describe("StickyComment", () => {
  test("creates a comment when none exists", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 1,
          body: "unrelated",
        },
      ],
    ]);
    await sticky(pr, fetch).upsert("new");
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      url: "https://api.github.test/repos/owner/repo/issues/7/comments",
      body: { body: "<!-- diffcop:review -->\nnew" },
    });
  });

  test("claims the comment for the current run", async () => {
    const { calls, fetch } = fakeGitHub([[]]);
    await sticky(run, fetch).upsert("new");
    expect(calls.at(-1)?.body).toEqual({
      body: "<!-- diffcop:review -->\n<!-- diffcop:run=42 -->\nnew",
    });
  });

  test("edits the existing diffcop comment, searching past the first page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => {
      return {
        id: i,
        body: "unrelated",
      };
    });
    const { calls, fetch } = fakeGitHub([
      firstPage,
      [
        {
          id: 500,
          body: diffcopComment(),
        },
      ],
    ]);
    await sticky(pr, fetch).upsert("new");
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: "https://api.github.test/repos/owner/repo/issues/comments/500",
      body: { body: "<!-- diffcop:review -->\nnew" },
    });
  });

  test("ignores a marked comment someone else wrote", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 400,
          body: diffcopComment("999999999"),
          user: { login: "someone" },
        },
        {
          id: 500,
          body: diffcopComment("41"),
        },
      ],
    ]);
    const posted = await sticky(run, fetch).upsert("new", {
      onlyIfOwned: true,
    });
    expect(posted).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: "https://api.github.test/repos/owner/repo/issues/comments/500",
    });
  });

  test("creates its own comment rather than editing someone else's", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 400,
          body: diffcopComment(),
          user: { login: "someone" },
        },
      ],
    ]);
    await sticky(pr, fetch).upsert("new");
    expect(calls.at(-1)?.method).toBe("POST");
  });

  test("onlyIfOwned leaves a comment claimed by a newer run alone", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: diffcopComment("43"),
        },
      ],
    ]);
    const posted = await sticky(run, fetch).upsert("new", {
      onlyIfOwned: true,
    });
    expect(posted).toBe(false);
    expect(
      calls.map((c) => {
        return c.method;
      }),
    ).toEqual(["GET"]);
  });

  test("onlyIfOwned takes over a comment an older run claimed", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: diffcopComment("41"),
        },
      ],
    ]);
    const posted = await sticky(run, fetch).upsert("new", {
      onlyIfOwned: true,
    });
    expect(posted).toBe(true);
    expect(calls.at(-1)?.method).toBe("PATCH");
  });

  test("onlyIfOwned edits the comment this run claimed", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: diffcopComment("42"),
        },
      ],
    ]);
    const posted = await sticky(run, fetch).upsert("new", {
      onlyIfOwned: true,
    });
    expect(posted).toBe(true);
    expect(calls.at(-1)?.method).toBe("PATCH");
  });

  test("throws on API errors", async () => {
    async function fetch() {
      return new Response("Bad credentials", { status: 401 });
    }
    expect(sticky(pr, fetch).upsert("x")).rejects.toThrow(
      "401 Bad credentials",
    );
  });

  test("throws when the viewer query has an unexpected shape", async () => {
    async function fetch() {
      return Response.json({ data: { viewer: null } });
    }
    expect(sticky(pr, fetch).upsert("x")).rejects.toThrow(
      "Unexpected response from GitHub's viewer query",
    );
  });

  test("throws when the comment list has an unexpected shape", async () => {
    async function fetch(url: string) {
      if (url.endsWith("/graphql")) {
        return Response.json({ data: { viewer: { login: BOT } } });
      }
      return Response.json([
        {
          id: "1",
          body: "x",
          user: null,
        },
      ]);
    }
    expect(sticky(pr, fetch).upsert("x")).rejects.toThrow(
      "Unexpected response from GitHub's comment list",
    );
  });

  test("retries a write that fails with a 5xx", async () => {
    const { calls, fetch } = fakeGitHub(
      [
        [
          {
            id: 500,
            body: diffcopComment(),
          },
        ],
      ],
      { writeFailures: 1 },
    );
    await sticky(pr, fetch).upsert("new");
    expect(
      calls.map((c) => {
        return c.method;
      }),
    ).toEqual(["GET", "PATCH", "PATCH"]);
  });

  test("retries a create that fails with a 5xx", async () => {
    const { calls, fetch } = fakeGitHub([[]], { writeFailures: 1 });
    await sticky(pr, fetch).upsert("new");
    expect(
      calls.map((c) => {
        return c.method;
      }),
    ).toEqual(["GET", "POST", "GET", "POST"]);
  });

  test("edits a created comment whose response was lost instead of posting again", async () => {
    const { calls, fetch } = fakeGitHub([[]], { lostResponses: 1 });
    await sticky(pr, fetch).upsert("new");
    expect(
      calls.map((c) => {
        return c.method;
      }),
    ).toEqual(["GET", "POST", "GET", "PATCH"]);
    expect(calls.at(-1)?.url).toBe(
      "https://api.github.test/repos/owner/repo/issues/comments/900",
    );
  });

  test("sends the token and the pinned API version", async () => {
    const { calls, fetch } = fakeGitHub([[]]);
    await sticky(pr, fetch).upsert("new");
    expect(calls[0]?.headers).toMatchObject({
      authorization: "token t",
      "x-github-api-version": "2022-11-28",
    });
  });

  test("location names the pull request", () => {
    expect(sticky(pr, fetch).location).toBe("owner/repo#7");
  });
});

describe("StickyComment.rewrite", () => {
  test("rewrites the comment for the run that claimed it, not the current run", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: `${diffcopComment("41")}\nold`,
        },
      ],
    ]);
    const seen: string[] = [];
    const written = await sticky(run, fetch).rewrite((body) => {
      seen.push(body);
      return "new";
    });
    expect(written).toBe(true);
    expect(seen).toEqual([`${diffcopComment("41")}\nold`]);
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: "https://api.github.test/repos/owner/repo/issues/comments/500",
      body: { body: "<!-- diffcop:review -->\n<!-- diffcop:run=41 -->\nnew" },
    });
  });

  test("leaves the comment alone when the update declines", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: diffcopComment("41"),
        },
      ],
    ]);
    const written = await sticky(run, fetch).rewrite(() => {
      return undefined;
    });
    expect(written).toBe(false);
    expect(
      calls.filter(({ method }) => {
        return method !== "GET";
      }),
    ).toEqual([]);
  });

  test("creates nothing when there's no comment to rewrite", async () => {
    const { calls, fetch } = fakeGitHub([[]]);
    const written = await sticky(run, fetch).rewrite(() => {
      return "new";
    });
    expect(written).toBe(false);
    expect(
      calls.filter(({ method }) => {
        return method !== "GET";
      }),
    ).toEqual([]);
  });
});
