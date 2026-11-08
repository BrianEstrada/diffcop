import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "@/context/repository";
import {
  currentPath,
  LINES_PER_CHUNK,
  planChunks,
  sourceKey,
  splitDiffByFile,
} from "@/review/diff-chunks";

function changed(path: string, lines: number): ChangedFile {
  return {
    path: path,
    additions: lines,
    deletions: 0,
  };
}

function paths(chunks: ChangedFile[][]) {
  return chunks.map((chunk) => {
    return chunk.map((file) => {
      return file.path;
    });
  });
}

describe("currentPath", () => {
  test.each([
    ["src/a.ts", "src/a.ts"],
    ["old.ts => new.ts", "new.ts"],
    ["src/{old => new}/a.ts", "src/new/a.ts"],
    ["src/{ => nested}/a.ts", "src/nested/a.ts"],
  ])("%s is %s", (path, expected) => {
    expect(currentPath(path)).toBe(expected);
  });
});

describe("sourceKey", () => {
  test.each([
    ["src/foo.ts", "src/foo"],
    ["src/foo.test.ts", "src/foo"],
    ["src/foo.stories.tsx", "src/foo"],
    ["src/foo.spec.ts", "src/foo"],
    ["src/__tests__/foo.js", "src/foo"],
    ["pkg/foo_test.go", "pkg/foo"],
    ["app/test_foo.py", "app/foo"],
    ["app/src/test/kotlin/FooTest.kt", "app/src/main/kotlin/Foo"],
    ["app/src/main/kotlin/Foo.kt", "app/src/main/kotlin/Foo"],
    [".github/.eslintrc", ".github/.eslintrc"],
  ])("%s keys as %s", (path, expected) => {
    expect(sourceKey(path)).toBe(expected);
  });
});

describe("planChunks", () => {
  test("keeps a change that fits one chunk in one chunk", () => {
    expect(
      paths(planChunks([changed("a.ts", 10), changed("b.ts", 10)], 6)),
    ).toEqual([["a.ts", "b.ts"]]);
  });

  test("packs neighbouring files up to about 400 lines, tests with their source", () => {
    const files = [
      changed("src/b.ts", 300),
      changed("src/a.test.ts", 50),
      changed("src/a.ts", 300),
      changed("src/b.test.ts", 50),
      changed("src/c.ts", 100),
    ];

    expect(paths(planChunks(files, 6))).toEqual([
      ["src/a.test.ts", "src/a.ts"],
      ["src/b.ts", "src/b.test.ts"],
      ["src/c.ts"],
    ]);
  });

  test("gives a file bigger than a chunk a chunk of its own", () => {
    expect(
      paths(planChunks([changed("a.ts", 900), changed("b.ts", 10)], 6)),
    ).toEqual([["a.ts"], ["b.ts"]]);
  });

  test("leaves lockfiles out", () => {
    expect(
      paths(planChunks([changed("bun.lock", 5_000), changed("a.ts", 10)], 6)),
    ).toEqual([["a.ts"]]);
  });

  test("grows chunks rather than pass the cap", () => {
    const files = Array.from({ length: 20 }, (_, i) => {
      return changed(`src/f${String(i).padStart(2, "0")}.ts`, LINES_PER_CHUNK);
    });

    const chunks = planChunks(files, 6);

    expect(chunks).toHaveLength(6);
    expect(chunks.flat()).toHaveLength(20);
  });

  test("merges the lightest neighbours when packing overshoots the cap", () => {
    const files = [
      changed("a.ts", 400),
      changed("b.ts", 50),
      changed("c.ts", 400),
      changed("d.ts", 400),
    ];

    expect(paths(planChunks(files, 3))).toEqual([
      ["a.ts", "b.ts"],
      ["c.ts"],
      ["d.ts"],
    ]);
  });
});

describe("splitDiffByFile", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts\n+a\n",
    "diff --git a/b.ts b/b.ts\n+diff --git inside a line\n",
  ].join("");

  test("maps each changed file to its section of the diff", () => {
    expect(
      splitDiffByFile(diff, [changed("a.ts", 1), changed("b.ts", 1)]),
    ).toEqual(
      new Map([
        ["a.ts", "diff --git a/a.ts b/a.ts\n+a\n"],
        ["b.ts", "diff --git a/b.ts b/b.ts\n+diff --git inside a line\n"],
      ]),
    );
  });

  test("gives up when the sections don't line up with the files", () => {
    expect(splitDiffByFile(diff, [changed("a.ts", 1)])).toBeUndefined();
  });
});
