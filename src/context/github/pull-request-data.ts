import { z } from "zod";

// The shape of claude-code-action's PR_QUERY, trimmed to the fields its prompt uses.

const author = z.object({ login: z.string() }).nullable();

const pullRequestComment = z.object({
  body: z.string(),
  author: author,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  lastEditedAt: z.string().nullish(),
  isMinimized: z.boolean(),
});

export type PullRequestComment = z.infer<typeof pullRequestComment>;

const pullRequestReviewComment = pullRequestComment.extend({
  path: z.string(),
  line: z.number().nullable(),
  diffHunk: z.string().optional(),
});

export type PullRequestReviewComment = z.infer<typeof pullRequestReviewComment>;

const pullRequestReview = z.object({
  author: author,
  body: z.string(),
  state: z.string(),
  submittedAt: z.string(),
  updatedAt: z.string().optional(),
  lastEditedAt: z.string().nullish(),
  comments: z.object({ nodes: z.array(pullRequestReviewComment) }),
});

export type PullRequestReview = z.infer<typeof pullRequestReview>;

const pullRequestFile = z.object({
  path: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changeType: z.string(),
});

export type PullRequestFile = z.infer<typeof pullRequestFile>;

export type PullRequestFileWithSha = PullRequestFile & { sha: string };

const pullRequestFiles = z.object({
  totalCount: z.number(),
  nodes: z.array(pullRequestFile),
});

export type PullRequestFiles = z.infer<typeof pullRequestFiles>;

export const pullRequestData = z.object({
  repo: z.string(),
  number: z.number(),
  action: z.string().optional(),
  title: z.string(),
  body: z.string(),
  author: author,
  headRefName: z.string(),
  baseRefName: z.string(),
  state: z.string(),
  additions: z.number(),
  deletions: z.number(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  commits: z.object({ totalCount: z.number() }),
  // null when GitHub won't list the files, usually because the diff is too large.
  files: pullRequestFiles.nullable(),
  comments: z.object({ nodes: z.array(pullRequestComment) }),
  reviews: z.object({ nodes: z.array(pullRequestReview) }),
});

export type PullRequestData = z.infer<typeof pullRequestData>;

export interface PullRequestSource {
  fetch(): Promise<PullRequestData>;
}
