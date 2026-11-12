import { describe, expect, test } from "bun:test";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import { z } from "zod";
import { GitHubClient } from "@/github/github-client";
import { ReviewComments } from "@/reporter/github/review-comments";

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
// An empty `head` is a comment from before diffcop recorded the commit.
function diffcopComment(runId?: string, head = pr.headSha) {
  return [
    "<!-- diffcop:review -->",
    ...(runId ? [`<!-- diffcop:run=${runId} -->`] : []),
    ...(head ? [`<!-- diffcop:head=${head} -->`] : []),
    "## diffcop review",
  ].join("\n");
}

const HEAD = "<!-- diffcop:head=abc1234def -->";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const BOT = "github-actions[bot]";

interface Comment {
  id: number;
  body: string;
  html_url?: string;
  node_id?: string;
  minimized?: boolean;
  user?: { login: string };
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

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

async function writtenBody(url: string, init?: RequestInit) {
  if (!init?.body) {
    return undefined;
  }
  return commentWrite.parse(await new Request(url, init).json());
}

// `lostResponses` writes that GitHub applies but answers with a 502. `deleted` comments are
// gone by the time they're looked up, and `refuseHides` fails every attempt to hide one.
// Comments are the bot's unless they say otherwise.
function fakeGitHub(
  pages: Comment[][],
  {
    writeFailures = 0,
    lostResponses = 0,
    deleted = false,
    refuseHides = false,
  } = {},
) {
  const calls: Call[] = [];
  const hidden: string[] = [];
  let failures = 0;
  let lost = 0;
  async function graphql(url: string, init?: RequestInit) {
    const { query, variables } = graphqlCall.parse(
      await new Request(url, init).json(),
    );
    if (query.includes("viewer")) {
      return Response.json({ data: { viewer: { login: BOT } } });
    }
    if (query.includes("minimizeComment")) {
      if (refuseHides) {
        return Response.json({ errors: [{ message: "Not allowed" }] });
      }
      hidden.push(variables?.id ?? "");
      return Response.json({ data: { minimizeComment: {} } });
    }
    const nodes = (variables?.ids ?? []).map((id) => {
      const comment = pages.flat().find((c) => {
        return c.node_id === id;
      });
      if (!comment || deleted) {
        return null;
      }
      return {
        id: id,
        isMinimized: comment.minimized === true,
      };
    });
    return Response.json({ data: { nodes: nodes } });
  }
  async function fetch(url: string, init?: RequestInit) {
    const method = init?.method ?? "GET";
    if (url.endsWith("/graphql")) {
      return graphql(url, init);
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
      if (method === "POST") {
        return Response.json({ html_url: "https://github.test/comment/900" });
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
    hidden: hidden,
    fetch: fetch,
  };
}

function comments(pullRequest: PullRequestContext, fetch: Fetch) {
  return new ReviewComments(
    pullRequest,
    new GitHubClient({
      auth: "t",
      baseUrl: pullRequest.apiUrl,
      request: { fetch: fetch },
      retry: { retryAfterBaseValue: 0 },
    }),
  );
}

describe("ReviewComments", () => {
  test("creates a comment when none exists", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 1,
          body: "unrelated",
        },
      ],
    ]);
    await comments(pr, fetch).upsert("new");
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      url: "https://api.github.test/repos/owner/repo/issues/7/comments",
      body: { body: `<!-- diffcop:review -->\n${HEAD}\nnew` },
    });
  });

  test("knows the page of the comment it created", async () => {
    const { fetch } = fakeGitHub([[]]);
    const comment = comments(pr, fetch);

    expect(comment.url).toBeUndefined();
    await comment.upsert("new");

    expect(comment.url).toBe("https://github.test/comment/900");
  });

  test("knows the page of the comment it found", async () => {
    const { fetch } = fakeGitHub([
      [
        {
          id: 5,
          body: diffcopComment(),
          html_url: "https://github.test/comment/5",
        },
      ],
    ]);
    const comment = comments(pr, fetch);

    await comment.upsert("updated");

    expect(comment.url).toBe("https://github.test/comment/5");
  });

  test("claims the comment for the current run", async () => {
    const { calls, fetch } = fakeGitHub([[]]);
    await comments(run, fetch).upsert("new");
    expect(calls.at(-1)?.body).toEqual({
      body: `<!-- diffcop:review -->\n<!-- diffcop:run=42 -->\n${HEAD}\nnew`,
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
    await comments(pr, fetch).upsert("new");
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: "https://api.github.test/repos/owner/repo/issues/comments/500",
      body: { body: `<!-- diffcop:review -->\n${HEAD}\nnew` },
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
    const posted = await comments(run, fetch).upsert("new", {
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
    await comments(pr, fetch).upsert("new");
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
    const posted = await comments(run, fetch).upsert("new", {
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
    const posted = await comments(run, fetch).upsert("new", {
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
    const posted = await comments(run, fetch).upsert("new", {
      onlyIfOwned: true,
    });
    expect(posted).toBe(true);
    expect(calls.at(-1)?.method).toBe("PATCH");
  });

  test("throws on API errors", async () => {
    async function fetch() {
      return new Response("Bad credentials", { status: 401 });
    }
    expect(comments(pr, fetch).upsert("x")).rejects.toThrow(
      "401 Bad credentials",
    );
  });

  test("throws when the viewer query has an unexpected shape", async () => {
    async function fetch() {
      return Response.json({ data: { viewer: null } });
    }
    expect(comments(pr, fetch).upsert("x")).rejects.toThrow(
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
    expect(comments(pr, fetch).upsert("x")).rejects.toThrow(
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
    await comments(pr, fetch).upsert("new");
    expect(
      calls.map((c) => {
        return c.method;
      }),
    ).toEqual(["GET", "PATCH", "PATCH"]);
  });

  test("retries a create that fails with a 5xx", async () => {
    const { calls, fetch } = fakeGitHub([[]], { writeFailures: 1 });
    await comments(pr, fetch).upsert("new");
    expect(
      calls.map((c) => {
        return c.method;
      }),
    ).toEqual(["GET", "POST", "GET", "POST"]);
  });

  test("edits a created comment whose response was lost instead of posting again", async () => {
    const { calls, fetch } = fakeGitHub([[]], { lostResponses: 1 });
    await comments(pr, fetch).upsert("new");
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
    await comments(pr, fetch).upsert("new");
    expect(calls[0]?.headers).toMatchObject({
      authorization: "token t",
      "x-github-api-version": "2022-11-28",
    });
  });

  test("location names the pull request", () => {
    expect(comments(pr, fetch).location).toBe("owner/repo#7");
  });
});

describe("ReviewComments.rewrite", () => {
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
    const written = await comments(run, fetch).rewrite((body) => {
      seen.push(body);
      return "new";
    });
    expect(written).toBe(true);
    expect(seen).toEqual([`${diffcopComment("41")}\nold`]);
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: "https://api.github.test/repos/owner/repo/issues/comments/500",
      body: {
        body: `<!-- diffcop:review -->\n<!-- diffcop:run=41 -->\n${HEAD}\nnew`,
      },
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
    const written = await comments(run, fetch).rewrite(() => {
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
    const written = await comments(run, fetch).rewrite(() => {
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

describe("ReviewComments, one comment per commit", () => {
  const EARLIER = "0000000aaa";

  function methods(calls: Call[]) {
    return calls.map(({ method }) => {
      return method;
    });
  }

  test("posts a new comment when the newest one reviews another commit", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: diffcopComment("41", EARLIER),
        },
      ],
    ]);
    const posted = await comments(run, fetch).upsert("new", {
      onlyIfOwned: true,
    });
    expect(posted).toBe(true);
    expect(methods(calls)).toEqual(["GET", "POST"]);
  });

  test("posts a new comment after one from before commits were recorded", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: diffcopComment("41", ""),
        },
      ],
    ]);
    await comments(run, fetch).upsert("new");
    expect(methods(calls)).toEqual(["GET", "POST"]);
  });

  test("edits the newest comment, not an earlier one of the same commit", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: diffcopComment("40"),
        },
        {
          id: 501,
          body: diffcopComment("41"),
        },
      ],
    ]);
    await comments(run, fetch).upsert("new");
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: "https://api.github.test/repos/owner/repo/issues/comments/501",
    });
  });

  test("posts again when a later commit was reviewed in between", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: diffcopComment("40"),
        },
        {
          id: 501,
          body: diffcopComment("41", EARLIER),
        },
      ],
    ]);
    await comments(run, fetch).upsert("new");
    expect(methods(calls)).toEqual(["GET", "POST"]);
  });

  test("doesn't take a marker quoted in the review for the comment's own", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: `${diffcopComment("41", EARLIER)}\n${HEAD}\n<!-- diffcop:run=99 -->`,
        },
      ],
    ]);
    const posted = await comments(run, fetch).upsert("new", {
      onlyIfOwned: true,
    });
    expect(posted).toBe(true);
    expect(methods(calls)).toEqual(["GET", "POST"]);
  });

  test("leaves the PR to a newer run, whichever commit that run reviewed", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: diffcopComment("43", EARLIER),
        },
      ],
    ]);
    const posted = await comments(run, fetch).upsert("new", {
      onlyIfOwned: true,
    });
    expect(posted).toBe(false);
    expect(methods(calls)).toEqual(["GET"]);
  });

  test("reads the newest comment", async () => {
    const { fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: `${diffcopComment("40", EARLIER)}\nfirst`,
        },
        {
          id: 501,
          body: `${diffcopComment("41")}\nsecond`,
          html_url: "https://github.test/comment/501",
        },
      ],
    ]);
    const store = comments(run, fetch);
    expect(await store.read()).toEndWith("second");
    expect(store.url).toBe("https://github.test/comment/501");
  });

  test("is superseded once a newer run has posted", async () => {
    const newer = fakeGitHub([
      [
        {
          id: 500,
          body: diffcopComment("43"),
        },
      ],
    ]);
    const older = fakeGitHub([
      [
        {
          id: 500,
          body: diffcopComment("41"),
        },
      ],
    ]);
    expect(await comments(run, newer.fetch).superseded()).toBe(true);
    expect(await comments(run, older.fetch).superseded()).toBe(false);
    expect(await comments(run, fakeGitHub([[]]).fetch).superseded()).toBe(
      false,
    );
  });

  test("reads the markers of a comment edited on github.com", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: diffcopComment("43").replaceAll("\n", "\r\n"),
        },
      ],
    ]);
    const store = comments(run, fetch);
    expect(await store.superseded()).toBe(true);
    expect(await comments(pr, fetch).upsert("new")).toBe(true);
    expect(calls.at(-1)?.method).toBe("PATCH");
  });

  test("rewrite keeps the comment's commit", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: `${diffcopComment("41", EARLIER)}\nold`,
        },
      ],
    ]);
    await comments(run, fetch).rewrite(() => {
      return "new";
    });
    expect(calls.at(-1)?.body).toEqual({
      body: `<!-- diffcop:review -->\n<!-- diffcop:run=41 -->\n<!-- diffcop:head=${EARLIER} -->\nnew`,
    });
  });
});

describe("ReviewComments, kept comments", () => {
  function isReview(body: string) {
    return body.includes("✅");
  }

  test("posts after a comment of this commit that is to be kept, not over it", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: `${diffcopComment("41")}\n✅ All good`,
        },
      ],
    ]);
    await comments(run, fetch).upsert("❌ failed", { keep: isReview });
    expect(calls.at(-1)?.method).toBe("POST");
  });

  test("still edits a comment of this commit that isn't kept", async () => {
    const { calls, fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: `${diffcopComment("41")}\n❌ failed`,
        },
      ],
    ]);
    await comments(run, fetch).upsert("❌ failed again", { keep: isReview });
    expect(calls.at(-1)?.method).toBe("PATCH");
  });

  test("reads every diffcop comment, oldest first", async () => {
    const { fetch } = fakeGitHub([
      [
        {
          id: 500,
          body: `${diffcopComment("40", "0000000aaa")}\nfirst`,
        },
        {
          id: 501,
          body: "unrelated",
        },
        {
          id: 502,
          body: `${diffcopComment("41")}\nby someone else`,
          user: { login: "someone" },
        },
      ],
      [
        {
          id: 503,
          body: `${diffcopComment("41")}\nsecond`,
        },
      ],
    ]);
    const bodies = await comments(run, fetch).readAll();
    expect(
      bodies.map((body) => {
        return body.split("\n").at(-1);
      }),
    ).toEqual(["first", "second"]);
  });
});

describe("ReviewComments.hideOutdated", () => {
  test("hides every earlier comment that still shows, and not the newest", async () => {
    const { hidden, fetch } = fakeGitHub([
      [
        {
          id: 500,
          node_id: "C500",
          body: diffcopComment("39"),
          minimized: true,
        },
        {
          id: 501,
          node_id: "C501",
          body: diffcopComment("40"),
        },
        {
          id: 502,
          node_id: "C502",
          body: "unrelated",
        },
        {
          id: 503,
          node_id: "C503",
          body: diffcopComment("41"),
          user: { login: "someone" },
        },
        {
          id: 504,
          node_id: "C504",
          body: diffcopComment("42"),
        },
      ],
    ]);
    expect(await comments(run, fetch).hideOutdated()).toBe(1);
    expect(hidden).toEqual(["C501"]);
  });

  test("hides nothing on a PR with one comment", async () => {
    const { hidden, fetch } = fakeGitHub([
      [
        {
          id: 500,
          node_id: "C500",
          body: diffcopComment("42"),
        },
      ],
    ]);
    expect(await comments(run, fetch).hideOutdated()).toBe(0);
    expect(hidden).toEqual([]);
  });

  test("skips a comment deleted since it was listed", async () => {
    const { hidden, fetch } = fakeGitHub(
      [
        [
          {
            id: 500,
            node_id: "C500",
            body: diffcopComment("41"),
          },
          {
            id: 501,
            node_id: "C501",
            body: diffcopComment("42"),
          },
        ],
      ],
      { deleted: true },
    );
    expect(await comments(run, fetch).hideOutdated()).toBe(0);
    expect(hidden).toEqual([]);
  });

  test("throws when GitHub refuses to hide a comment", async () => {
    const { fetch } = fakeGitHub(
      [
        [
          {
            id: 500,
            node_id: "C500",
            body: diffcopComment("41"),
          },
          {
            id: 501,
            node_id: "C501",
            body: diffcopComment("42"),
          },
        ],
      ],
      { refuseHides: true },
    );
    expect(comments(run, fetch).hideOutdated()).rejects.toThrow("Not allowed");
  });
});
