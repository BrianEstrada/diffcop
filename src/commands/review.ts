import { defineCommand } from "citty";
import { z } from "zod";
import {
  ClaudeCodeReviewerAgent,
  EFFORTS,
} from "@/agent/claude-code/claude-code-agent";
import { GitRepository } from "@/context/git/git-repository";
import { readPullRequestContext } from "@/context/github/pull-request-context";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import { PullRequestFetcher } from "@/context/github/pull-request-fetcher";
import { ReviewContextCollector } from "@/context/review-context-collector";
import { ReviewPromptBuilder } from "@/prompt/review-prompt-builder";
import { ConsoleReporter } from "@/reporter/console/console-reporter";
import { JsonReporter } from "@/reporter/console/json-reporter";
import { GitHubClient } from "@/github/github-client";
import { CommitStatus } from "@/reporter/github/commit-status";
import { GitHubReporter } from "@/reporter/github/github-reporter";
import {
  lastReview,
  ledgerFromComments,
} from "@/reporter/github/ledger-marker";
import { ReviewCommentFormatter } from "@/reporter/github/review-comment-formatter";
import { ReviewComments } from "@/reporter/github/review-comments";
import type { ReviewReporter } from "@/reporter/review-reporter";
import { ChangeSizeLimit } from "@/review/change-size-limit";
import {
  CodeReviewer,
  DEFAULT_MAX_CHUNKS,
  MAX_CHUNKS_LIMIT,
} from "@/review/code-reviewer";
import { DescriptionRechecker } from "@/review/description-rechecker";
import type { RecheckOutcome } from "@/review/description-rechecker";
import { FindAndVerify } from "@/review/find-and-verify";
import { outstandingWork } from "@/review/outstanding-work";
import { LedgerFile } from "@/review/ledger-file";
import { appendRound, earlierRounds } from "@/review/review-ledger";
import type { ReviewLedger } from "@/review/review-ledger";
import { isDescriptionFinding } from "@/review/saved-review";
import { SavedReviewComment } from "@/reporter/github/saved-review-comment";

const REPORTERS = ["console", "json", "github"] as const;

type ReporterName = (typeof REPORTERS)[number];

function parsePositiveInt(flag: string, value: string) {
  const result = z.coerce.number().int().positive().safeParse(value);
  if (!result.success) {
    throw new Error(`--${flag} must be a positive integer, not "${value}".`);
  }
  return result.data;
}

function parseMaxChunks(value: string) {
  const result = z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_CHUNKS_LIMIT)
    .safeParse(value);
  if (!result.success) {
    throw new Error(
      `--maxChunks must be an integer from 1 to ${MAX_CHUNKS_LIMIT}, not "${value}".`,
    );
  }
  return result.data;
}

function createGitHubClient(pr: PullRequestContext | undefined) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!pr || !token) {
    return undefined;
  }
  return new GitHubClient({
    auth: token,
    baseUrl: pr.apiUrl,
  });
}

function createPullRequestSource(
  pr: PullRequestContext | undefined,
  github: GitHubClient | undefined,
) {
  if (!pr) {
    return undefined;
  }
  if (!github) {
    process.stderr.write(
      "No GITHUB_TOKEN or GH_TOKEN, so the review won't see the PR's description, comments or reviews.\n",
    );
    return undefined;
  }
  return new PullRequestFetcher(pr, github);
}

function createGitHubComment(
  pr: PullRequestContext | undefined,
  github: GitHubClient | undefined,
) {
  if (!pr) {
    throw new Error(
      "--reporter github only works in a GitHub Actions pull_request run.",
    );
  }
  if (!github) {
    throw new Error(
      "--reporter github needs GITHUB_TOKEN or GH_TOKEN to post the review.",
    );
  }
  return {
    comment: new ReviewComments(pr, github),
    status: new CommitStatus(pr, github, process.stderr),
    formatter: new ReviewCommentFormatter(pr, {
      secrets: [
        process.env.GITHUB_TOKEN,
        process.env.GH_TOKEN,
        process.env.ANTHROPIC_API_KEY,
        process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ],
    }),
  };
}

type GitHubComment = ReturnType<typeof createGitHubComment>;

function createLocalReporter(
  name: Exclude<ReporterName, "github">,
): ReviewReporter {
  switch (name) {
    case "console":
      return new ConsoleReporter(process.stdout, process.stderr, {
        colors: process.stdout.isTTY,
        columns: process.stdout.columns,
      });
    case "json":
      return new JsonReporter(process.stdout);
  }
}

function recheckLine(outcome: RecheckOutcome) {
  switch (outcome.status) {
    case "skipped":
      return `Skipped the description re-check: ${outcome.reason}.`;
    case "superseded":
      return "A newer review or re-check replaced the comment first; leaving it alone.";
    case "rechecked":
      return `Re-checked the description: ${outcome.findings} finding${outcome.findings === 1 ? "" : "s"} left.`;
  }
}

export default defineCommand({
  meta: {
    name: "review",
    description: "Review local changes against a base branch",
  },
  args: {
    prompt: {
      type: "positional",
      description: "What to ask the reviewer",
      required: true,
    },
    base: {
      type: "string",
      description:
        "Base ref to diff against (default: the PR's base in GitHub Actions, else origin/HEAD, else main)",
    },
    cwd: {
      type: "string",
      description: "Repository directory",
      default: ".",
    },
    model: {
      type: "string",
      description: "Model override",
    },
    maxTurns: {
      type: "string",
      description: "Maximum agent turns per pass (default: Claude Code's)",
    },
    maxLines: {
      type: "string",
      description:
        "Warn when the change has more added plus deleted lines than this, lockfiles aside",
      default: "1000",
    },
    maxFiles: {
      type: "string",
      description:
        "Warn when the change touches more files than this, lockfiles aside",
      default: "20",
    },
    effort: {
      type: "enum",
      options: [...EFFORTS],
      description: "How hard the model thinks (default: Claude Code's)",
    },
    maxChunks: {
      type: "string",
      description: `Split a diff into up to this many chunks of about 400 changed lines, each reviewed twice (1 to ${MAX_CHUNKS_LIMIT}); 1 reviews it in one pass`,
      default: String(DEFAULT_MAX_CHUNKS),
    },
    ledger: {
      type: "string",
      description:
        "File that keeps what earlier reviews of this change found, so the next one doesn't repeat them. For local runs: --reporter github reads them from its PR comments",
    },
    full: {
      type: "boolean",
      description:
        "When the change was reviewed before, look for minor findings in all of it again, not only in what changed since",
    },
    reporter: {
      type: "enum",
      options: [...REPORTERS],
      default: "console",
      description:
        "Where the review goes: console shows progress then the findings, json prints one object when done, github posts it as a PR comment and a commit status (GitHub Actions only; needs GITHUB_TOKEN or GH_TOKEN)",
    },
    debug: {
      type: "boolean",
      description:
        "With --reporter github, also log tool calls and thinking time",
    },
  },
  // Composition root: the only place that picks concrete implementations.
  run: async function ({ args }) {
    let maxTurns: number | undefined;
    if (args.maxTurns !== undefined) {
      maxTurns = parsePositiveInt("maxTurns", args.maxTurns);
    }
    const maxChunks = parseMaxChunks(args.maxChunks);
    const sizeLimit = new ChangeSizeLimit({
      maxLines: parsePositiveInt("maxLines", args.maxLines),
      maxFiles: parsePositiveInt("maxFiles", args.maxFiles),
    });
    const pr = await readPullRequestContext(process.env);
    const github = createGitHubClient(pr);
    // Built before the review runs so a misconfigured job fails fast.
    let githubComment: GitHubComment | undefined;
    let reporter: ReviewReporter;
    if (args.reporter === "github") {
      if (args.ledger !== undefined) {
        throw new Error(
          "--ledger is for local runs; --reporter github reads the earlier rounds from its PR comments.",
        );
      }
      githubComment = createGitHubComment(pr, github);
      reporter = new GitHubReporter(
        githubComment.comment,
        githubComment.formatter,
        githubComment.status,
        process.stderr,
        { debug: args.debug === true },
      );
    } else {
      reporter = createLocalReporter(args.reporter);
    }

    const repository = new GitRepository(args.cwd);
    const collector = new ReviewContextCollector(
      repository,
      createPullRequestSource(pr, github),
    );
    const promptBuilder = new ReviewPromptBuilder();
    const agent = new ClaudeCodeReviewerAgent({
      model: args.model,
      maxTurns: maxTurns,
      effort: args.effort,
    });

    // Actions sends SIGINT, then SIGTERM, when a job is cancelled or times out.
    const abort = new AbortController();
    process.once("SIGINT", () => {
      abort.abort();
    });
    process.once("SIGTERM", () => {
      abort.abort();
    });

    // Never reports a failure: a failed or cancelled re-check leaves the last review and its status showing.
    async function recheckDescription(
      edited: PullRequestContext,
      editedCollector: ReviewContextCollector,
    ) {
      const { comment, formatter, status } = createGitHubComment(
        edited,
        github,
      );
      const rechecker = new DescriptionRechecker(
        editedCollector,
        promptBuilder,
        new FindAndVerify(promptBuilder, agent, reporter),
        new SavedReviewComment(comment, formatter, status),
      );
      const outcome = await rechecker.recheck(
        {
          headSha: edited.headSha,
          descriptionAt: edited.triggerTime,
        },
        {
          base: args.base,
          abortSignal: abort.signal,
        },
      );
      process.stderr.write(`${recheckLine(outcome)}\n`);
    }

    let ledgerFile: LedgerFile | undefined;
    if (args.ledger !== undefined) {
      ledgerFile = new LedgerFile(args.ledger);
    }
    // What earlier reviews of this change found: from diffcop's comments on the PR,
    // each of which keeps its own round, or from the --ledger file of a local run.
    let ledger: ReviewLedger | undefined;
    let full = args.full === true;
    if (githubComment && pr) {
      const comments = await githubComment.comment.readAll();
      const edited = pr.action === "edited";
      const work = outstandingWork(
        {
          headSha: pr.headSha,
          baseRef: pr.baseRef,
          edited: edited,
          baseChanged: edited && !pr.descriptionEdited,
        },
        lastReview(comments.at(-1)),
      );
      if (work.kind === "recheck") {
        await recheckDescription(pr, collector);
        return;
      }
      if (work.reason !== undefined) {
        process.stderr.write(`${work.reason}\n`);
      }
      full ||= work.full;
      ledger = ledgerFromComments(comments);
    } else {
      ledger = await ledgerFile?.load();
    }
    // A round is keyed by its commit, so reviewing one again redoes its round.
    let headSha = pr?.headSha;
    if (headSha === undefined && ledgerFile) {
      headSha = await repository.headSha();
    }

    const reviewer = new CodeReviewer(
      collector,
      promptBuilder,
      agent,
      reporter,
      sizeLimit,
    );
    const result = await reviewer.review({
      request: args.prompt,
      base: args.base,
      maxChunks: maxChunks,
      rounds: headSha === undefined ? [] : earlierRounds(ledger, headSha),
      full: full,
      abortSignal: abort.signal,
    });
    if (ledgerFile && headSha !== undefined) {
      await ledgerFile.save(appendRound(ledger, headSha, result));
    }

    // An edit made while the review ran found no saved review to re-check and skipped.
    if (
      args.reporter !== "github" ||
      !pr ||
      !github ||
      !result.findings.some(isDescriptionFinding)
    ) {
      return;
    }
    try {
      const edited = await new PullRequestFetcher(
        pr,
        github,
      ).editedSinceEvent();
      if (edited) {
        process.stderr.write(
          "The title or description changed during the review; re-checking it.\n",
        );
        await recheckDescription(
          edited,
          new ReviewContextCollector(
            new GitRepository(args.cwd),
            new PullRequestFetcher(edited, github),
          ),
        );
      }
    } catch (error) {
      // The review is posted; a failed re-check shouldn't fail its run.
      process.stderr.write(
        `Couldn't re-check the edited description: ${String(error)}\n`,
      );
    }
  },
});
