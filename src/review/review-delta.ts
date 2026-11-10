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

const NEW_SIDE = "+++ ";

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
function unquote(quoted: string) {
  return quoted.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (_, escape: string) => {
    if (escape.length === 3) {
      return String.fromCharCode(Number.parseInt(escape, 8));
    }
    return NAMED_ESCAPES[escape] ?? escape;
  });
}

// Undefined for a deleted file (`/dev/null`), and for a binary file or a pure rename, which have no header.
function newPath(header: string[]) {
  const line = header.find((text) => {
    return text.startsWith(NEW_SIDE);
  });
  if (line === undefined) {
    return undefined;
  }
  // Git ends a path that has a space with a tab.
  const raw = line.slice(NEW_SIDE.length).replace(/\t$/, "");
  const path = raw.startsWith('"') ? unquote(raw) : raw;
  return path.startsWith("b/") ? path.slice("b/".length) : undefined;
}

function parseSection(section: string): [string, DeltaFile] | undefined {
  const lines = section.split("\n");
  const firstHunk = lines.findIndex((text) => {
    return HUNK.test(text);
  });
  if (firstHunk === -1) {
    return undefined;
  }
  const path = newPath(lines.slice(0, firstHunk));
  if (path === undefined) {
    return undefined;
  }
  const file: DeltaFile = {
    touched: new Set(),
    additions: 0,
    deletions: 0,
  };
  let line = 0;
  for (const text of lines.slice(firstHunk)) {
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
  return [path, file];
}

// `diff` is `Repository.patchSince`'s; only the sections of `paths`, the reviewed files, are kept.
export function parseDelta(
  since: string,
  diff: string,
  paths: ReadonlySet<string>,
): ReviewDelta {
  const sections = diff.split(/^(?=diff --git )/m).flatMap((section) => {
    const parsed = parseSection(section);
    if (!parsed || !paths.has(parsed[0])) {
      return [];
    }
    return [
      {
        text: section.replace(/\n?$/, "\n"),
        parsed: parsed,
      },
    ];
  });
  return {
    since: since,
    diff: sections
      .map(({ text }) => {
        return text;
      })
      .join(""),
    files: new Map(
      sections.map(({ parsed }) => {
        return parsed;
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
