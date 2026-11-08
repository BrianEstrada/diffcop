import { basename, dirname } from "node:path";
import type { ChangedFile } from "@/context/repository";
import { isLockfile } from "@/review/change-size-limit";

// A finder per this many changed lines, until the finder cap makes chunks grow.
export const LINES_PER_CHUNK = 400;

function changedLines(files: ChangedFile[]) {
  return files.reduce((sum, file) => {
    return sum + file.additions + file.deletions;
  }, 0);
}

// `git diff --numstat` writes a rename as `old => new` or `dir/{old => new}/file`.
export function currentPath(path: string) {
  const braced = path.replace(/\{[^{}]* => ([^{}]*)\}/g, "$1");
  const [, after] = braced.split(" => ");
  return (after ?? braced).replaceAll("//", "/").replace(/^\//, "");
}

// The source file a test belongs with: `foo.test.ts`, `foo_test.go`, `foo_spec.rb`,
// `test_foo.py`, `FooTest.kt` under src/test and `__tests__/foo.js` all key as `foo`.
export function sourceKey(path: string) {
  const current = currentPath(path);
  const dir = dirname(current)
    .replace(/^__tests__$/, ".")
    .replace(/\/__tests__$/, "")
    .replace(/(^|\/)src\/test(\/|$)/, "$1src/main$2");
  const name = basename(current);
  const stem = (name.split(".")[0] || name)
    .replace(/^test_/, "")
    .replace(/(_test|_spec|Tests?|Spec)$/, "");
  return `${dir}/${stem}`;
}

// Neighbouring files packed into chunks of about LINES_PER_CHUNK changed lines,
// each test kept with its source, at most `maxChunks` chunks. Lockfiles are left out.
export function planChunks(changedFiles: ChangedFile[], maxChunks: number) {
  const counted = changedFiles.filter((file) => {
    return !isLockfile(file.path);
  });
  const total = changedLines(counted);
  const target = Math.max(LINES_PER_CHUNK, Math.ceil(total / maxChunks));
  const groups = [
    ...Map.groupBy(counted, (file) => {
      return sourceKey(file.path);
    }).entries(),
  ]
    .toSorted(([a], [b]) => {
      return a.localeCompare(b);
    })
    .map(([, files]) => {
      return files;
    });

  const chunks: ChangedFile[][] = [];
  let current: ChangedFile[] = [];
  for (const group of groups) {
    if (
      current.length > 0 &&
      changedLines(current) + changedLines(group) > target
    ) {
      chunks.push(current);
      current = [];
    }
    current = [...current, ...group];
  }
  if (current.length > 0) {
    chunks.push(current);
  }

  // Greedy packing can overshoot the cap; merge the lightest neighbours until it fits.
  while (chunks.length > Math.max(1, maxChunks)) {
    const pairs = chunks.slice(1).map((next, index) => {
      return changedLines([...(chunks[index] ?? []), ...next]);
    });
    const lightest = pairs.indexOf(Math.min(...pairs));
    chunks.splice(lightest, 2, [
      ...(chunks[lightest] ?? []),
      ...(chunks[lightest + 1] ?? []),
    ]);
  }
  return chunks;
}

// `git diff` and `git diff --numstat` list files in the same order, so the
// diff's sections line up with the changed files. Undefined when they don't.
export function splitDiffByFile(diff: string, changedFiles: ChangedFile[]) {
  const sections = diff.split(/^(?=diff --git )/m).filter((section) => {
    return section.startsWith("diff --git ");
  });
  if (sections.length !== changedFiles.length) {
    return undefined;
  }
  return new Map(
    changedFiles.map((file, index) => {
      // Sections are joined in any order, and git's trimmed output drops the last one's newline.
      return [file.path, (sections[index] ?? "").replace(/\n?$/, "\n")];
    }),
  );
}
