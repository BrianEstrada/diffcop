import type {
  PullRequestData,
  PullRequestFile,
  PullRequestFileWithSha,
  PullRequestSource,
} from "@/context/github/pull-request-data";
import type { ChangedFile, Repository } from "@/context/repository";
import { currentPath } from "@/review/diff-chunks";
import { parseDelta } from "@/review/review-delta";
import type { ReviewDelta } from "@/review/review-delta";
import type { LedgerRound } from "@/review/review-ledger";

export interface PullRequestDetails {
  data: PullRequestData;
  changedFilesWithSha: PullRequestFileWithSha[];
}

// Earlier reviews of the same change, oldest round first.
export interface PreviousReview {
  rounds: LedgerRound[];
  // Absent when the last reviewed commit isn't in HEAD's history (a rebase or
  // force-push), or when a full review was asked for.
  delta?: ReviewDelta;
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
  // Only when the change was reviewed before.
  previous?: PreviousReview;
}

export interface CollectOptions {
  // What earlier reviews of this change found; none makes this a first review.
  rounds?: LedgerRound[];
  // Open the whole change to minor findings again, not only what changed since the last round.
  full?: boolean;
}

// Local equivalent of claude-code-action's fetchGitHubData, read from git.
export class ReviewContextCollector {
  readonly #repository: Repository;
  readonly #pullRequest: PullRequestSource | undefined;

  constructor(repository: Repository, pullRequest?: PullRequestSource) {
    this.#repository = repository;
    this.#pullRequest = pullRequest;
  }

  async collect(
    baseRef?: string,
    { rounds = [], full = false }: CollectOptions = {},
  ): Promise<ReviewContext> {
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

    const previous = await this.#previous(rounds, full, changedFiles);
    return {
      repoRoot: repoRoot,
      branch: branch,
      base: base,
      mergeBase: mergeBase,
      commits: commits,
      changedFiles: changedFiles,
      diff: diff,
      pullRequest: pullRequest,
      ...(previous && { previous: previous }),
    };
  }

  async #previous(
    rounds: LedgerRound[],
    full: boolean,
    changedFiles: ChangedFile[],
  ): Promise<PreviousReview | undefined> {
    const since = rounds.at(-1)?.headSha;
    if (since === undefined) {
      return undefined;
    }
    const repository = this.#repository;
    if (
      full ||
      changedFiles.length === 0 ||
      !(await repository.isAncestor(since))
    ) {
      return { rounds: rounds };
    }
    // The whole tree's diff, cut down to the reviewed files once git has paired
    // renames: a pathspec would show a file renamed since then as wholly new.
    const paths = new Set(
      changedFiles.map((file) => {
        return currentPath(file.path);
      }),
    );
    return {
      rounds: rounds,
      delta: parseDelta(since, await repository.patchSince(since), paths),
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
