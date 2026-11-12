import { RequestError } from "@octokit/request-error";
import { z } from "zod";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import type { GitHubClient } from "@/github/github-client";
import { unwrapResponse } from "@/github/unwrap-response";

// Retries for creating the comment, on top of the first attempt.
const CREATE_RETRIES = 3;

// Hidden in the comment body so later runs find diffcop's comments.
const MARKER = "<!-- diffcop:review -->";

// A `nodes` query takes at most this many ids.
const MAX_NODES = 100;

const issueComments = z.array(
  z.object({
    id: z.number(),
    node_id: z.string().optional(),
    body: z.string().optional(),
    html_url: z.string().optional(),
    user: z.object({ login: z.string() }).nullable(),
  }),
);

type IssueComment = z.infer<typeof issueComments>[number];

const createdComment = z.object({ html_url: z.string() });

const viewerQuery = z.object({ viewer: z.object({ login: z.string() }) });

// Null for a comment deleted since it was listed.
const minimizedQuery = z.object({
  nodes: z.array(
    z
      .object({
        id: z.string(),
        isMinimized: z.boolean(),
      })
      .nullable(),
  ),
});

// Records which Actions run last claimed the comment, so a run that was
// superseded doesn't overwrite the newer run's review.
function runMarker(runId: string) {
  return `<!-- diffcop:run=${runId} -->`;
}

// Records which commit the comment reviews: each commit gets a comment of its own.
function headMarker(headSha: string) {
  return `<!-- diffcop:head=${headSha} -->`;
}

// The markers that open the body. A finding's text further down can quote one, so only these count.
// A comment edited on github.com comes back with CRLF line endings.
function header(body: string) {
  const lines = body.split(/\r?\n/);
  const end = lines.findIndex((line) => {
    return !/^<!-- diffcop:[^>]* -->$/.test(line);
  });
  return lines.slice(0, end === -1 ? lines.length : end);
}

function claimedRun(body: string) {
  return header(body)
    .join("\n")
    .match(/<!-- diffcop:run=(\d+) -->/)?.[1];
}

function reviewedHead(body: string) {
  return header(body)
    .join("\n")
    .match(/<!-- diffcop:head=([0-9a-f]+) -->/)?.[1];
}

// Octokit's error message is only GitHub's response message, so say which
// request failed and with what status.
function describeFailure(cause: unknown) {
  if (!(cause instanceof RequestError)) {
    return cause;
  }
  const { method, url } = cause.request;
  return new Error(
    `GitHub API ${method} ${url} failed: ${cause.status} ${cause.message}`,
    { cause: cause },
  );
}

// diffcop's comments on a PR: one per reviewed commit, the newest being the current review.
// Find-then-create isn't atomic, and GitHub can't create a comment only if absent,
// so runs for one PR must be serialized (the workflow's `concurrency` group).
export class ReviewComments {
  readonly #pr: PullRequestContext;
  readonly #github: GitHubClient;
  #login: Promise<string> | undefined;
  #url: string | undefined;

  constructor(pr: PullRequestContext, github: GitHubClient) {
    this.#pr = pr;
    this.#github = github;
  }

  get location() {
    return `${this.#pr.repo}#${this.#pr.number}`;
  }

  // The newest comment's page, once a read or a write has seen it.
  get url() {
    return this.#url;
  }

  // Edits the newest comment when it's about this commit, and posts a new one otherwise.
  // With `onlyIfOwned`, skips the write and returns false if a newer run has
  // claimed the newest comment; a claim by an older (e.g. cancelled) run is taken over.
  async upsert(body: string, { onlyIfOwned = false } = {}) {
    try {
      return await this.#upsert(body, onlyIfOwned);
    } catch (error) {
      throw describeFailure(error);
    }
  }

  async read() {
    try {
      return (await this.#newest())?.body;
    } catch (error) {
      throw describeFailure(error);
    }
  }

  // Whether a newer run has claimed the newest comment, so this run should leave the PR alone.
  async superseded() {
    try {
      return this.#claimedByNewerRun(await this.#newest());
    } catch (error) {
      throw describeFailure(error);
    }
  }

  // Edits the newest comment in place, keeping its run and commit, so a re-check never outranks a newer
  // review. `update` gets the current body and returns undefined to leave it; false if nothing was written.
  async rewrite(update: (body: string) => string | undefined) {
    try {
      const existing = await this.#newest();
      const body = existing?.body;
      const updated = body === undefined ? undefined : update(body);
      if (!existing || body === undefined || updated === undefined) {
        return false;
      }
      await this.#github.request(
        "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
        {
          ...this.#repo(),
          comment_id: existing.id,
          body: [...header(body), updated].join("\n"),
        },
      );
      return true;
    } catch (error) {
      throw describeFailure(error);
    }
  }

  // Collapses every diffcop comment but the newest, as GitHub's "hide as outdated" does,
  // and returns how many it hid.
  async hideOutdated() {
    try {
      const older = (await this.#mine()).slice(0, -1).flatMap((comment) => {
        return comment.node_id === undefined ? [] : [comment.node_id];
      });
      const visible = await this.#visible(older.slice(-MAX_NODES));
      for (const id of visible) {
        await this.#github.graphql<unknown>(
          `mutation ($id: ID!) {
            minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
              clientMutationId
            }
          }`,
          { id: id },
        );
      }
      return visible.length;
    } catch (error) {
      throw describeFailure(error);
    }
  }

  // Asked first, so a round costs one hide and not one per earlier round.
  async #visible(ids: string[]) {
    if (ids.length === 0) {
      return [];
    }
    const result = await this.#github.graphql<unknown>(
      `query ($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on IssueComment {
            id
            isMinimized
          }
        }
      }`,
      { ids: ids },
    );
    const { nodes } = unwrapResponse(
      minimizedQuery.safeParse(result),
      "GitHub's comment query",
    );
    return nodes.flatMap((node) => {
      if (!node || node.isMinimized) {
        return [];
      }
      return [node.id];
    });
  }

  async #upsert(
    body: string,
    onlyIfOwned: boolean,
    attempt = 1,
  ): Promise<boolean> {
    const { runId, headSha } = this.#pr;
    const newest = await this.#newest();
    if (onlyIfOwned && this.#claimedByNewerRun(newest)) {
      return false;
    }

    const fullBody = [
      MARKER,
      ...(runId ? [runMarker(runId)] : []),
      headMarker(headSha),
      body,
    ].join("\n");
    if (newest?.body !== undefined && reviewedHead(newest.body) === headSha) {
      await this.#github.request(
        "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
        {
          ...this.#repo(),
          comment_id: newest.id,
          body: fullBody,
        },
      );
      return true;
    }
    try {
      const created = await this.#github.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          ...this.#repo(),
          issue_number: this.#pr.number,
          body: fullBody,
          // GitHub can create the comment and still fail the response, so a
          // blind retry would post a second one. Retry from the lookup instead.
          request: { retries: 0 },
        },
      );
      this.#url = createdComment.safeParse(created.data).data?.html_url;
    } catch (error) {
      if (
        attempt > CREATE_RETRIES ||
        !(error instanceof RequestError) ||
        error.status < 500
      ) {
        throw error;
      }
      await Bun.sleep(attempt ** 2 * this.#github.retryAfterBaseValue);
      return this.#upsert(body, onlyIfOwned, attempt + 1);
    }
    return true;
  }

  #claimedByNewerRun(comment: IssueComment | undefined) {
    const { runId } = this.#pr;
    const claimedBy = comment?.body ? claimedRun(comment.body) : undefined;
    return Boolean(runId && claimedBy && Number(claimedBy) > Number(runId));
  }

  async #newest() {
    const newest = (await this.#mine()).at(-1);
    this.#url = newest?.html_url;
    return newest;
  }

  // Oldest first, as GitHub lists them.
  async #mine() {
    const pages = this.#github.paginate.iterator(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        ...this.#repo(),
        issue_number: this.#pr.number,
        per_page: 100,
      },
    );
    // Anyone who can comment can paste the marker, so only our own comments count.
    const login = await this.#viewerLogin();
    const mine: IssueComment[] = [];
    for await (const { data } of pages) {
      const comments = unwrapResponse(
        issueComments.safeParse(data),
        "GitHub's comment list",
      );
      mine.push(
        ...comments.filter((c) => {
          return c.user?.login === login && c.body?.includes(MARKER);
        }),
      );
    }
    return mine;
  }

  // GraphQL, since REST's GET /user rejects the Actions installation token.
  async #viewerLogin() {
    this.#login ??= this.#github
      .graphql<unknown>("query { viewer { login } }")
      .then((result) => {
        const { viewer } = unwrapResponse(
          viewerQuery.safeParse(result),
          "GitHub's viewer query",
        );
        return viewer.login;
      });
    try {
      return await this.#login;
    } catch (error) {
      this.#login = undefined;
      throw error;
    }
  }

  #repo() {
    const [owner = "", repo = ""] = this.#pr.repo.split("/");
    return {
      owner: owner,
      repo: repo,
    };
  }
}
