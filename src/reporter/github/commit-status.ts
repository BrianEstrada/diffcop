import { RequestError } from "@octokit/request-error";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import type { GitHubClient } from "@/github/github-client";
import type { ReviewResult } from "@/review/findings";
import { reviewHeadline } from "@/reporter/review-layout";
import type { TextSink } from "@/reporter/review-reporter";

// The name the status shows under in the PR's checks, and the one to mark as required.
const CONTEXT = "diffcop";

// GitHub rejects a longer description.
const MAX_DESCRIPTION_CHARS = 140;

export interface StatusUpdate {
  state: "pending" | "success" | "failure" | "error";
  description: string;
  // Where the status links to; the run when left out.
  url?: string;
}

export const REVIEWING: StatusUpdate = {
  state: "pending",
  description: "Reviewing…",
};

export function reviewStatus(
  result: Pick<ReviewResult, "findings">,
  url?: string,
): StatusUpdate {
  const { blocking, text } = reviewHeadline(result.findings);
  return {
    state: blocking ? "failure" : "success",
    description: text,
    url: url,
  };
}

export function failureStatus(cancelled: boolean): StatusUpdate {
  if (cancelled) {
    return {
      state: "error",
      description: "The review was cancelled",
    };
  }
  return {
    state: "error",
    description: "The review failed",
  };
}

// The review's verdict as a commit status on the PR's head commit. Posting never
// throws: the comment holds the review, so a missing status shouldn't fail the run.
export class CommitStatus {
  readonly #pr: PullRequestContext;
  readonly #github: GitHubClient;
  readonly #log: TextSink;
  #denied = false;

  constructor(pr: PullRequestContext, github: GitHubClient, log: TextSink) {
    this.#pr = pr;
    this.#github = github;
    this.#log = log;
  }

  async post({ state, description, url }: StatusUpdate) {
    if (this.#denied) {
      return;
    }
    const [owner = "", repo = ""] = this.#pr.repo.split("/");
    const target = url ?? this.#pr.runUrl;
    try {
      await this.#github.request("POST /repos/{owner}/{repo}/statuses/{sha}", {
        owner: owner,
        repo: repo,
        sha: this.#pr.headSha,
        state: state,
        context: CONTEXT,
        description: description.slice(0, MAX_DESCRIPTION_CHARS),
        ...(target && { target_url: target }),
      });
    } catch (error) {
      if (error instanceof RequestError && error.status === 403) {
        // Said once, not for every update of the run.
        this.#denied = true;
        this.#log.write(
          `Skipping the diffcop status: GitHub refused it (${error.message}). The workflow's permissions need \`statuses: write\`.\n`,
        );
        return;
      }
      this.#log.write(`Couldn't post the diffcop status: ${String(error)}\n`);
    }
  }
}
