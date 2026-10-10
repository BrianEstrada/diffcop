import { Octokit } from "@octokit/core";
import type { OctokitOptions } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { retry } from "@octokit/plugin-retry";

const API_VERSION = "2022-11-28";

// Retries with backoff so a transient 5xx doesn't fail a finished review.
export class GitHubClient extends Octokit.plugin(paginateRest, retry) {
  // For callers that retry a request themselves, to back off like the plugin.
  readonly retryAfterBaseValue: number;

  constructor(options: OctokitOptions = {}) {
    super({
      userAgent: "diffcop",
      ...options,
    });
    this.retryAfterBaseValue = options.retry?.retryAfterBaseValue ?? 1000;
    this.hook.before("request", (request) => {
      request.headers["x-github-api-version"] = API_VERSION;
    });
  }
}
