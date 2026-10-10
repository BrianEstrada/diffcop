import type {
  PullRequestComment,
  PullRequestData,
  PullRequestFiles,
  PullRequestFileWithSha,
  PullRequestReview,
} from "../../context/github/pull-request-data";
import { sanitizeContent } from "./sanitize-content";

// Ports of claude-code-action's formatters (src/github/data/formatter.ts at
// ed670b4), without the image downloads.

function login(author: { login: string } | null) {
  return author?.login ?? "ghost";
}

function formatLabels(labels: { name: string }[]) {
  if (labels.length === 0) {
    return "none";
  }
  return labels
    .map((label) => {
      return label.name;
    })
    .join(", ");
}

function formatFileCount(files: PullRequestFiles | null) {
  if (!files) {
    return "unknown (file list unavailable)";
  }
  // Not nodes.length: the query lists at most 100 files.
  return `${files.totalCount} files`;
}

export function formatContext(pr: PullRequestData) {
  return [
    `PR Title: ${sanitizeContent(pr.title)}`,
    `PR Author: ${login(pr.author)}`,
    `PR Branch: ${pr.headRefName} -> ${pr.baseRefName}`,
    `PR State: ${pr.state}`,
    `PR Labels: ${formatLabels(pr.labels.nodes)}`,
    `PR Additions: ${pr.additions}`,
    `PR Deletions: ${pr.deletions}`,
    `Total Commits: ${pr.commits.totalCount}`,
    `Changed Files: ${formatFileCount(pr.files)}`,
  ].join("\n");
}

export function formatComments(comments: PullRequestComment[]) {
  return comments
    .filter((comment) => {
      return !comment.isMinimized;
    })
    .map((comment) => {
      return `[${login(comment.author)} at ${comment.createdAt}]: ${sanitizeContent(comment.body)}`;
    })
    .join("\n\n");
}

function formatReview(review: PullRequestReview) {
  const lines = [
    `[Review by ${login(review.author)} at ${review.submittedAt}]: ${review.state}`,
  ];
  if (review.body.trim()) {
    lines.push(sanitizeContent(review.body));
  }
  for (const comment of review.comments.nodes) {
    if (comment.isMinimized) {
      continue;
    }
    lines.push(
      `  [Comment on ${comment.path}:${comment.line || "?"}]: ${sanitizeContent(comment.body)}`,
    );
    // The hunk is the code the comment was left on; without it the comment
    // loses the context it was written against.
    if (comment.diffHunk) {
      lines.push(
        `  Diff context:\n\`\`\`diff\n${sanitizeContent(comment.diffHunk)}\n\`\`\``,
      );
    }
  }
  return lines.join("\n");
}

export function formatReviewComments(reviews: PullRequestReview[]) {
  return reviews.map(formatReview).join("\n\n");
}

export function formatChangedFilesWithSha(files: PullRequestFileWithSha[]) {
  return files
    .map((file) => {
      return `- ${file.path} (${file.changeType}) +${file.additions}/-${file.deletions} SHA: ${file.sha}`;
    })
    .join("\n");
}
