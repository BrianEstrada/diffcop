import { describe, expect, test } from "bun:test";
import { parseDelta, touchesDelta } from "@/review/review-delta";

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
  "diff --git a/src/new file.ts b/src/new file.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new file.ts",
  "@@ -0,0 +1,2 @@",
  "+one",
  "+two",
].join("\n");

describe("parseDelta", () => {
  const delta = parseDelta("abc1234", DIFF);

  test("keeps the commit and the diff it was parsed from", () => {
    expect(delta.since).toBe("abc1234");
    expect(delta.diff).toBe(DIFF);
  });

  test("lists added lines, and the line after a removed one, by new-side number", () => {
    const file = delta.files.get("src/a.ts");

    expect([...(file?.touched ?? [])]).toEqual([4, 5, 7, 42]);
    expect(file?.additions).toBe(3);
    expect(file?.deletions).toBe(1);
  });

  test("reads a path with a space", () => {
    expect([...(delta.files.get("src/new file.ts")?.touched ?? [])]).toEqual([
      1, 2,
    ]);
  });

  test("leaves deleted and binary files out", () => {
    expect([...delta.files.keys()]).toEqual(["src/a.ts", "src/new file.ts"]);
  });

  test("finds no files in an empty diff", () => {
    expect(parseDelta("abc1234", "").files.size).toBe(0);
  });
});

describe("touchesDelta", () => {
  const delta = parseDelta("abc1234", DIFF);

  test.each([
    [1, 3, false],
    [1, 4, true],
    [5, 5, true],
    [6, 6, false],
    [7, 7, true],
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
