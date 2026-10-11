import { z } from "zod";
import type { GitHubClient } from "../../github/github-client";
import { unwrapResponse } from "../../github/unwrap-response";
import type { PullRequestContext } from "./pull-request-context";
import { pullRequestData } from "./pull-request-data";
import type { PullRequestData, PullRequestSource } from "./pull-request-data";

const COMMENT_FIELDS = `
  body
  author { login }
  createdAt
  updatedAt
  lastEditedAt
  isMinimized`;

const PR_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        author { login }
        baseRefName
        headRefName
        additions
        deletions
        state
        labels(first: 100) { nodes { name } }
        commits(first: 100) { totalCount }
        files(first: 100) {
          totalCount
          nodes { path additions deletions changeType }
        }
        comments(first: 100) { nodes { ${COMMENT_FIELDS} } }
        reviews(first: 100) {
          nodes {
            author { login }
            body
            state
            submittedAt
            updatedAt
            lastEditedAt
            comments(first: 100) {
              nodes { ${COMMENT_FIELDS} path line diffHunk }
            }
          }
        }
      }
    }
  }
`;

const queryResult = z.object({
  repository: z.object({
    pullRequest: pullRequestData
      .omit({
        repo: true,
        number: true,
        action: true,
        title: true,
        body: true,
      })
      .nullable(),
  }),
});

interface Timestamps {
  updatedAt?: string;
  lastEditedAt?: string | null;
}

// Port of claude-code-action's filterCommentsToTriggerTime: anything created or
// edited at or after the trigger could have been planted after the push.
function existedBefore(
  createdAt: string,
  { updatedAt, lastEditedAt }: Timestamps,
  triggerTime: string | undefined,
) {
  if (!triggerTime) {
    return true;
  }
  const trigger = new Date(triggerTime).getTime();
  if (new Date(createdAt).getTime() >= trigger) {
    return false;
  }
  const lastEdit = lastEditedAt || updatedAt;
  return !lastEdit || new Date(lastEdit).getTime() < trigger;
}

// claude-code-action's fetchGitHubData, for a pull_request event.
export class PullRequestFetcher implements PullRequestSource {
  readonly #pr: PullRequestContext;
  readonly #github: GitHubClient;

  constructor(pr: PullRequestContext, github: GitHubClient) {
    this.#pr = pr;
    this.#github = github;
  }

  async fetch(): Promise<PullRequestData> {
    const { repo, number, action, title, body, triggerTime } = this.#pr;
    const [owner = "", name = ""] = repo.split("/");
    const result = unwrapResponse(
      queryResult.safeParse(
        await this.#github.graphql<unknown>(PR_QUERY, {
          owner: owner,
          repo: name,
          number: number,
        }),
      ),
      "GitHub's pull request query",
    );
    const pullRequest = result.repository.pullRequest;
    if (!pullRequest) {
      throw new Error(`Pull request ${repo}#${number} not found.`);
    }

    const reviews = pullRequest.reviews.nodes
      .filter((review) => {
        return existedBefore(review.submittedAt, review, triggerTime);
      })
      .map((review) => {
        return {
          ...review,
          comments: {
            nodes: review.comments.nodes.filter((comment) => {
              return existedBefore(comment.createdAt, comment, triggerTime);
            }),
          },
        };
      });

    return {
      ...pullRequest,
      repo: repo,
      number: number,
      action: action,
      title: title,
      body: body,
      comments: {
        nodes: pullRequest.comments.nodes.filter((comment) => {
          return existedBefore(comment.createdAt, comment, triggerTime);
        }),
      },
      reviews: { nodes: reviews },
    };
  }
}
