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
import { GitHubReporter } from "@/reporter/github/github-reporter";
import { ReviewCommentFormatter } from "@/reporter/github/review-comment-formatter";
import { StickyComment } from "@/reporter/github/sticky-comment";
import type { ReviewReporter } from "@/reporter/review-reporter";
import { ChangeSizeLimit } from "@/review/change-size-limit";
import { CodeReviewer } from "@/review/code-reviewer";
import { DescriptionRechecker } from "@/review/description-rechecker";
import type { RecheckOutcome } from "@/review/description-rechecker";
import { FindAndVerify } from "@/review/find-and-verify";
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
    comment: new StickyComment(pr, github),
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

function createGitHubReporter(
  pr: PullRequestContext | undefined,
  github: GitHubClient | undefined,
  debug: boolean,
) {
  const { comment, formatter } = createGitHubComment(pr, github);
  return new GitHubReporter(comment, formatter, process.stderr, {
    debug: debug,
  });
}

function createReporter(
  name: ReporterName,
  pr: PullRequestContext | undefined,
  github: GitHubClient | undefined,
  debug: boolean,
): ReviewReporter {
  switch (name) {
    case "console":
      return new ConsoleReporter(process.stdout, process.stderr, {
        colors: process.stdout.isTTY,
        columns: process.stdout.columns,
      });
    case "json":
      return new JsonReporter(process.stdout);
    case "github":
      return createGitHubReporter(pr, github, debug);
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
    reporter: {
      type: "enum",
      options: [...REPORTERS],
      default: "console",
      description:
        "Where the review goes: console shows progress then the findings, json prints one object when done, github keeps it in a PR comment (GitHub Actions only; needs GITHUB_TOKEN or GH_TOKEN)",
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
    const sizeLimit = new ChangeSizeLimit({
      maxLines: parsePositiveInt("maxLines", args.maxLines),
      maxFiles: parsePositiveInt("maxFiles", args.maxFiles),
    });
    const pr = await readPullRequestContext(process.env);
    const github = createGitHubClient(pr);
    // Built before the review runs so a misconfigured job fails fast.
    const reporter = createReporter(
      args.reporter,
      pr,
      github,
      args.debug === true,
    );

    const collector = new ReviewContextCollector(
      new GitRepository(args.cwd),
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

    // Never posts a status: a failed or cancelled re-check leaves the last review showing.
    async function recheckDescription(
      edited: PullRequestContext,
      editedCollector: ReviewContextCollector,
    ) {
      const { comment, formatter } = createGitHubComment(edited, github);
      const rechecker = new DescriptionRechecker(
        editedCollector,
        promptBuilder,
        new FindAndVerify(promptBuilder, agent, reporter),
        new SavedReviewComment(comment, formatter),
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

    if (args.reporter === "github" && pr?.descriptionEdited) {
      await recheckDescription(pr, collector);
      return;
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
      abortSignal: abort.signal,
    });

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
