import { defineCommand } from "citty";
import { z } from "zod";
import {
  ClaudeCodeReviewerAgent,
  EFFORTS,
} from "../agent/claude-code/claude-code-agent";
import { GitRepository } from "../context/git/git-repository";
import { readPullRequestContext } from "../context/github/pull-request-context";
import type { PullRequestContext } from "../context/github/pull-request-context";
import { PullRequestFetcher } from "../context/github/pull-request-fetcher";
import { ReviewContextCollector } from "../context/review-context-collector";
import { ReviewPromptBuilder } from "../prompt/review-prompt-builder";
import { ConsoleReporter } from "../reporter/console/console-reporter";
import { JsonReporter } from "../reporter/console/json-reporter";
import { GitHubClient } from "../github/github-client";
import { GitHubReporter } from "../reporter/github/github-reporter";
import { ReviewCommentFormatter } from "../reporter/github/review-comment-formatter";
import { StickyComment } from "../reporter/github/sticky-comment";
import type { ReviewReporter } from "../reporter/review-reporter";
import { ChangeSizeLimit } from "../review/change-size-limit";
import { CodeReviewer } from "../review/code-reviewer";

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

function createGitHubReporter(
  pr: PullRequestContext | undefined,
  github: GitHubClient | undefined,
  debug: boolean,
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
  return new GitHubReporter(
    new StickyComment(pr, github),
    new ReviewCommentFormatter(pr, {
      secrets: [
        process.env.GITHUB_TOKEN,
        process.env.GH_TOKEN,
        process.env.ANTHROPIC_API_KEY,
        process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ],
    }),
    process.stderr,
    { debug: debug },
  );
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

    const reviewer = new CodeReviewer(
      new ReviewContextCollector(
        new GitRepository(args.cwd),
        createPullRequestSource(pr, github),
      ),
      new ReviewPromptBuilder(),
      new ClaudeCodeReviewerAgent({
        model: args.model,
        maxTurns: maxTurns,
        effort: args.effort,
      }),
      reporter,
      sizeLimit,
    );

    // Actions sends SIGINT, then SIGTERM, when a job is cancelled or times out.
    const abort = new AbortController();
    process.once("SIGINT", () => {
      abort.abort();
    });
    process.once("SIGTERM", () => {
      abort.abort();
    });

    await reviewer.review({
      request: args.prompt,
      base: args.base,
      abortSignal: abort.signal,
    });
  },
});
