import type {
  PullRequestData,
  PullRequestFile,
  PullRequestFileWithSha,
  PullRequestSource,
} from "@/context/github/pull-request-data";
import type { ChangedFile, Repository } from "@/context/repository";

export interface PullRequestDetails {
  data: PullRequestData;
  changedFilesWithSha: PullRequestFileWithSha[];
}

export interface ReviewContext {
  repoRoot: string;
  branch: string;
  base: string;
  mergeBase: string;
  commits: string[];
  changedFiles: ChangedFile[];
  diff: string;
  pullRequest?: PullRequestDetails;
}

// Local equivalent of claude-code-action's fetchGitHubData, read from git.
export class ReviewContextCollector {
  readonly #repository: Repository;
  readonly #pullRequest: PullRequestSource | undefined;

  constructor(repository: Repository, pullRequest?: PullRequestSource) {
    this.#repository = repository;
    this.#pullRequest = pullRequest;
  }

  async collect(baseRef?: string): Promise<ReviewContext> {
    const repository = this.#repository;
    // First, so a bad --cwd fails as such rather than as a missing merge base.
    const repoRoot = await repository.root();
    const pullRequest = await this.#fetchPullRequest();
    const base = baseRef ?? (await this.#defaultBase(pullRequest));
    const mergeBase = await repository.mergeBase(base).catch(() => {
      throw new Error(
        `Cannot find a merge base between HEAD and '${base}'. Pass --base.`,
      );
    });

    const [branch, commits, changedFiles, diff] = await Promise.all([
      repository.currentBranch(),
      repository.commitsSince(mergeBase),
      repository.changedFilesSince(mergeBase),
      repository.diffSince(mergeBase),
    ]);

    return {
      repoRoot: repoRoot,
      branch: branch,
      base: base,
      mergeBase: mergeBase,
      commits: commits,
      changedFiles: changedFiles,
      diff: diff,
      pullRequest: pullRequest,
    };
  }

  // Not the event payload's base: a push and a retarget seconds apart send the
  // push's event with the old base, and re-running the job replays it.
  async #defaultBase(pullRequest: PullRequestDetails | undefined) {
    if (pullRequest) {
      return `origin/${pullRequest.data.baseRefName}`;
    }
    return this.#repository.defaultBase();
  }

  async #fetchPullRequest(): Promise<PullRequestDetails | undefined> {
    if (!this.#pullRequest) {
      return undefined;
    }
    const data = await this.#pullRequest.fetch();
    return {
      data: data,
      changedFilesWithSha: await Promise.all(
        (data.files?.nodes ?? []).map((file) => {
          return this.#withSha(file);
        }),
      ),
    };
  }

  // The same SHAs claude-code-action lists in changed_files.
  async #withSha(file: PullRequestFile) {
    if (file.changeType === "DELETED") {
      return {
        ...file,
        sha: "deleted",
      };
    }
    const sha = await this.#repository.hashObject(file.path).catch(() => {
      return "unknown";
    });
    return {
      ...file,
      sha: sha,
    };
  }
}
