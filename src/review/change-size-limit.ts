import { basename } from "node:path";
import type { ChangedFile } from "../context/repository";

// Generated, often huge, and not worth the reviewer's attention.
const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

export interface ChangeSize {
  lines: number;
  files: number;
}

export interface ChangeSizeLimits {
  maxLines: number;
  maxFiles: number;
}

// Binary files count as files but add no lines: `git diff --numstat` gives
// them `-` for both counts.
export function measureChangeSize(changedFiles: ChangedFile[]): ChangeSize {
  const counted = changedFiles.filter((file) => {
    return !LOCKFILES.has(basename(file.path));
  });
  return {
    lines: counted.reduce((sum, file) => {
      return sum + file.additions + file.deletions;
    }, 0),
    files: counted.length,
  };
}

function count(n: number, unit: string) {
  if (n === 1) {
    return `1 ${unit}`;
  }
  return `${n.toLocaleString("en-US")} ${unit}s`;
}

function overLimit(actual: number, limit: number, unit: string) {
  const text = count(actual, unit);
  if (actual <= limit) {
    return text;
  }
  return `${text} (over the ${limit.toLocaleString("en-US")}-${unit} limit)`;
}

export class ChangeSizeLimit {
  readonly #limits: ChangeSizeLimits;

  constructor(limits: ChangeSizeLimits) {
    this.#limits = limits;
  }

  warning(changedFiles: ChangedFile[]): string | undefined {
    const { maxLines, maxFiles } = this.#limits;
    const { lines, files } = measureChangeSize(changedFiles);
    if (lines <= maxLines && files <= maxFiles) {
      return undefined;
    }
    return (
      `This change is large: ${overLimit(lines, maxLines, "line")} across ` +
      `${overLimit(files, maxFiles, "file")}, not counting lockfiles. ` +
      "Large changes get less accurate reviews; consider splitting it into stacked PRs."
    );
  }
}

// Far more files than GitHub lists for the PR means the diff used another base,
// e.g. one changed after the run started, so splitting the PR wouldn't help.
export function staleBaseWarning(
  base: string,
  localFiles: number,
  githubFiles: number | undefined,
): string | undefined {
  if (
    githubFiles === undefined ||
    localFiles <= githubFiles * 2 ||
    localFiles - githubFiles <= 10
  ) {
    return undefined;
  }
  return (
    `The diff against ${base} has ${count(localFiles, "file")}, but GitHub lists ` +
    `${count(githubFiles, "file")} for this PR, so its base may have changed after ` +
    "this run started. Re-run the review to diff against the current base."
  );
}
