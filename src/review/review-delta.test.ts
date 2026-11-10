import { describe, expect, test } from "bun:test";
import { parseDelta, touchesDelta } from "@/review/review-delta";

// As `git diff` prints it: a path with a space ends in a tab, and one with a quote is C-quoted.
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -3,4 +3,5 @@ function a() {",
  " three",
  "+four",
  "+five",
  " six",
  "-gone",
  " seven",
  "@@ -40,2 +41,3 @@",
  " forty-one",
  "+forty-two",
  " forty-three",
  "\\ No newline at end of file",
  "diff --git a/src/deleted.ts b/src/deleted.ts",
  "deleted file mode 100644",
  "--- a/src/deleted.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-only line",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
  "diff --git a/src/moved.ts b/src/renamed.ts",
  "similarity index 100%",
  "rename from src/moved.ts",
  "rename to src/renamed.ts",
  "diff --git a/src/new file.ts b/src/new file.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new file.ts\t",
  "@@ -0,0 +1,2 @@",
  "+one",
  "+two",
  'diff --git "a/say \\"hi\\".ts" "b/say \\"hi\\".ts"',
  '--- "a/say \\"hi\\".ts"\t',
  '+++ "b/say \\"hi\\".ts"\t',
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "diff --git a/src/tail.ts b/src/tail.ts",
  "--- a/src/tail.ts",
  "+++ b/src/tail.ts",
  "@@ -8,3 +8,2 @@",
  " eight",
  " nine",
  "-ten",
  "diff --git a/src/elsewhere.ts b/src/elsewhere.ts",
  "--- a/src/elsewhere.ts",
  "+++ b/src/elsewhere.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

const REVIEWED = new Set([
  "src/a.ts",
  "src/deleted.ts",
  "logo.png",
  "src/renamed.ts",
  "src/new file.ts",
  'say "hi".ts',
  "src/tail.ts",
]);

describe("parseDelta", () => {
  const delta = parseDelta("abc1234", DIFF, REVIEWED);

  test("keeps the commit, and only the reviewed files' sections of the diff", () => {
    expect(delta.since).toBe("abc1234");
    expect(delta.diff).toStartWith("diff --git a/src/a.ts b/src/a.ts\n");
    expect(delta.diff).toContain("+++ b/src/tail.ts\n");
    expect(delta.diff).not.toContain("src/elsewhere.ts");
    expect(delta.diff).not.toContain("logo.png");
    expect(delta.diff).toEndWith("-ten\n");
  });

  test("lists added lines, and the line after a removed one, by new-side number", () => {
    const file = delta.files.get("src/a.ts");

    expect([...(file?.touched ?? [])]).toEqual([4, 5, 6, 7, 42]);
    expect(file?.additions).toBe(3);
    expect(file?.deletions).toBe(1);
  });

  test("reads a path with a space, which git ends with a tab", () => {
    expect([...(delta.files.get("src/new file.ts")?.touched ?? [])]).toEqual([
      1, 2,
    ]);
  });

  test("reads a path git quoted", () => {
    expect(delta.files.get('say "hi".ts')?.additions).toBe(1);
  });

  test("marks the last line when the lines after it were removed", () => {
    expect([...(delta.files.get("src/tail.ts")?.touched ?? [])]).toEqual([
      9, 10,
    ]);
  });

  test("leaves out deleted and binary files, pure renames and files that aren't under review", () => {
    expect([...delta.files.keys()]).toEqual([
      "src/a.ts",
      "src/new file.ts",
      'say "hi".ts',
      "src/tail.ts",
    ]);
  });

  test("finds no files in an empty diff", () => {
    expect(parseDelta("abc1234", "", REVIEWED).files.size).toBe(0);
  });
});

describe("touchesDelta", () => {
  const delta = parseDelta("abc1234", DIFF, REVIEWED);

  test.each([
    [1, 3, false],
    [1, 4, true],
    [5, 5, true],
    [6, 7, true],
    [8, 8, false],
    [8, 41, false],
    [30, 60, true],
  ])("lines %i-%i of a changed file: %p", (startLine, endLine, expected) => {
    expect(
      touchesDelta(
        {
          file: "src/a.ts",
          startLine: startLine,
          endLine: endLine,
        },
        delta,
      ),
    ).toBe(expected);
  });

  test("is false for a file that didn't change", () => {
    expect(
      touchesDelta(
        {
          file: "src/other.ts",
          startLine: 1,
          endLine: 100,
        },
        delta,
      ),
    ).toBe(false);
  });

  test("treats a range that ends before it starts as its first line", () => {
    expect(
      touchesDelta(
        {
          file: "src/a.ts",
          startLine: 4,
          endLine: 1,
        },
        delta,
      ),
    ).toBe(true);
  });
});
