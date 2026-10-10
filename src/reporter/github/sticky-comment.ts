import { RequestError } from "@octokit/request-error";
import { z } from "zod";
import type { PullRequestContext } from "../../context/github/pull-request-context";
import type { GitHubClient } from "../../github/github-client";
import { parseResponse } from "../../github/parse-response";

// Retries for creating the comment, on top of the first attempt.
const CREATE_RETRIES = 3;

// Hidden in the comment body so later runs find and edit the same comment.
const MARKER = "<!-- diffcop:review -->";

const issueComments = z.array(
  z.object({
    id: z.number(),
    body: z.string().optional(),
    user: z.object({ login: z.string() }).nullable(),
  }),
);

const viewerQuery = z.object({ viewer: z.object({ login: z.string() }) });

// Records which Actions run last claimed the comment, so a run that was
// superseded doesn't overwrite the newer run's status.
function runMarker(runId: string) {
  return `<!-- diffcop:run=${runId} -->`;
}

function claimedRun(body: string) {
  return body.match(/<!-- diffcop:run=(\d+) -->/)?.[1];
}

// Octokit's error message is only GitHub's response message, so say which
// request failed and with what status.
function describeFailure(error: unknown) {
  if (!(error instanceof RequestError)) {
    return error;
  }
  const { method, url } = error.request;
  return new Error(
    `GitHub API ${method} ${url} failed: ${error.status} ${error.message}`,
    { cause: error },
  );
}

// Find-then-create isn't atomic, and GitHub can't create a comment only if absent,
// so runs for one PR must be serialized (the workflow's `concurrency` group).
export class StickyComment {
  readonly #pr: PullRequestContext;
  readonly #github: GitHubClient;
  #login: Promise<string> | undefined;

  constructor(pr: PullRequestContext, github: GitHubClient) {
    this.#pr = pr;
    this.#github = github;
  }

  get location() {
    return `${this.#pr.repo}#${this.#pr.number}`;
  }

  // With `onlyIfOwned`, skips the write and returns false if a newer run has
  // claimed the comment; a claim by an older (e.g. cancelled) run is taken over.
  async upsert(body: string, { onlyIfOwned = false } = {}) {
    try {
      return await this.#upsert(body, onlyIfOwned);
    } catch (error) {
      throw describeFailure(error);
    }
  }

  async #upsert(
    body: string,
    onlyIfOwned: boolean,
    attempt = 1,
  ): Promise<boolean> {
    const { runId } = this.#pr;
    const existing = await this.#find();
    const claimedBy = existing?.body ? claimedRun(existing.body) : undefined;
    if (
      onlyIfOwned &&
      runId &&
      claimedBy &&
      Number(claimedBy) > Number(runId)
    ) {
      return false;
    }

    const fullBody = [MARKER, ...(runId ? [runMarker(runId)] : []), body].join(
      "\n",
    );
    if (existing) {
      await this.#github.request(
        "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
        {
          ...this.#repo(),
          comment_id: existing.id,
          body: fullBody,
        },
      );
      return true;
    }
    try {
      await this.#github.request(
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

  async #find() {
    const pages = this.#github.paginate.iterator(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        ...this.#repo(),
        issue_number: this.#pr.number,
        per_page: 100,
      },
    );
    // Anyone who can comment can paste the marker, so only our own comment counts.
    const login = await this.#viewerLogin();
    for await (const { data } of pages) {
      const comments = parseResponse(
        issueComments,
        data,
        "GitHub's comment list",
      );
      const match = comments.find((c) => {
        return c.user?.login === login && c.body?.includes(MARKER);
      });
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  // GraphQL, since REST's GET /user rejects the Actions installation token.
  async #viewerLogin() {
    this.#login ??= this.#github
      .graphql<unknown>("query { viewer { login } }")
      .then((result) => {
        const { viewer } = parseResponse(
          viewerQuery,
          result,
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
