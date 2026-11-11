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
  // Only the reviewed files' sections.
  diff: string;
  // By the file's current path.
  files: Map<string, DeltaFile>;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)/;

const NAMED_ESCAPES: Record<string, string> = {
  a: "\u0007",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
};

// Git C-quotes a path that has a quote, a backslash or a control character.
function unquote(path: string) {
  if (!path.startsWith('"')) {
    return path;
  }
  return path.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (_, escape: string) => {
    if (escape.length === 3) {
      return String.fromCharCode(Number.parseInt(escape, 8));
    }
    return NAMED_ESCAPES[escape] ?? escape;
  });
}

// The path on the header line that starts with `start`, without `prefix`.
// Undefined without such a line, and for `/dev/null`, which has no prefix.
function headerPath(header: string[], start: string, prefix = "") {
  const line = header.find((text) => {
    return text.startsWith(start);
  });
  if (line === undefined) {
    return undefined;
  }
  // Git ends a path that has a space with a tab.
  const path = unquote(line.slice(start.length).replace(/\t$/, ""));
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

interface Section {
  // The file's current path, or its last one if it was deleted.
  path: string;
  text: string;
  // Absent when no line of the current file changed: a deletion or a rename alone.
  file?: DeltaFile;
}

function touchedLines(hunks: string[]): DeltaFile {
  const file: DeltaFile = {
    touched: new Set(),
    additions: 0,
    deletions: 0,
  };
  let line = 0;
  for (const text of hunks) {
    const start = text.match(HUNK)?.[1];
    if (start !== undefined) {
      line = Number(start);
    } else if (text.startsWith("+")) {
      file.touched.add(line);
      file.additions++;
      line++;
    } else if (text.startsWith("-")) {
      // Both neighbours, since a removal at the end of a file has no line after it.
      file.touched.add(Math.max(1, line - 1)).add(line);
      file.deletions++;
    } else if (!text.startsWith("\\")) {
      // Anything but "\ No newline at end of file" is a context line.
      line++;
    }
  }
  return file;
}

// Undefined for a section that names no path this way: a binary file or a mode change.
function parseSection(text: string): Section | undefined {
  const lines = text.split("\n");
  const firstHunk = lines.findIndex((line) => {
    return HUNK.test(line);
  });
  const header = firstHunk === -1 ? lines : lines.slice(0, firstHunk);
  const current = headerPath(header, "+++ ", "b/");
  const path =
    current ??
    headerPath(header, "--- ", "a/") ??
    headerPath(header, "rename to ");
  if (path === undefined) {
    return undefined;
  }
  const section: Section = {
    path: path,
    text: text.replace(/\n?$/, "\n"),
  };
  if (current !== undefined && firstHunk !== -1) {
    section.file = touchedLines(lines.slice(firstHunk));
  }
  return section;
}

// `diff` is `Repository.patchSince`'s; only the sections of `paths`, the reviewed files, are kept.
export function parseDelta(
  since: string,
  diff: string,
  paths: ReadonlySet<string>,
): ReviewDelta {
  const sections = diff.split(/^(?=diff --git )/m).flatMap((text) => {
    const section = parseSection(text);
    if (!section || !paths.has(section.path)) {
      return [];
    }
    return [section];
  });
  return {
    since: since,
    diff: sections
      .map(({ text }) => {
        return text;
      })
      .join(""),
    files: new Map(
      sections.flatMap(({ path, file }) => {
        return file ? [[path, file] as const] : [];
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
