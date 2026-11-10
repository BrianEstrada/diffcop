import type { Finding } from "@/review/findings";

export interface DeltaFile {
  // New-side line numbers that were added, or that follow a removed line.
  touched: Set<number>;
  additions: number;
  deletions: number;
}

// What changed in the reviewed files since the last review.
export interface ReviewDelta {
  // The commit the last review saw.
  since: string;
  diff: string;
  // By the file's current path.
  files: Map<string, DeltaFile>;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)/;

function parseSection(section: string): [string, DeltaFile] | undefined {
  const lines = section.split("\n");
  // Absent for a binary file, and `/dev/null` for a deleted one.
  const path = lines
    .find((line) => {
      return line.startsWith("+++ b/");
    })
    ?.slice("+++ b/".length);
  if (path === undefined) {
    return undefined;
  }
  const file: DeltaFile = {
    touched: new Set(),
    additions: 0,
    deletions: 0,
  };
  let line = 0;
  let inHunk = false;
  for (const text of lines) {
    const start = text.match(HUNK)?.[1];
    if (start !== undefined) {
      line = Number(start);
      inHunk = true;
    } else if (!inHunk || text.startsWith("\\")) {
      // The file header, or "\ No newline at end of file".
    } else if (text.startsWith("+")) {
      file.touched.add(line);
      file.additions++;
      line++;
    } else if (text.startsWith("-")) {
      file.touched.add(line);
      file.deletions++;
    } else {
      line++;
    }
  }
  return [path, file];
}

// Expects `a/` and `b/` prefixes, which `Repository.diffOfFilesSince` asks git for.
export function parseDelta(since: string, diff: string): ReviewDelta {
  const sections = diff.split(/^(?=diff --git )/m).filter((section) => {
    return section.startsWith("diff --git ");
  });
  return {
    since: since,
    diff: diff,
    files: new Map(
      sections.flatMap((section) => {
        const parsed = parseSection(section);
        return parsed ? [parsed] : [];
      }),
    ),
  };
}

export function touchesDelta(
  { file, startLine, endLine }: Pick<Finding, "file" | "startLine" | "endLine">,
  delta: ReviewDelta,
) {
  const touched = delta.files.get(file)?.touched;
  if (!touched) {
    return false;
  }
  for (const line of touched) {
    if (line >= startLine && line <= Math.max(startLine, endLine)) {
      return true;
    }
  }
  return false;
}
