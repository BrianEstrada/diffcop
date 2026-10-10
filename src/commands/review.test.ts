import { describe, expect, test } from "bun:test";

describe("review", () => {
  test.each([
    ["maxTurns", "abc"],
    ["maxTurns", "0"],
    ["maxTurns", "2.5"],
    ["maxLines", "-1"],
    ["maxLines", "lots"],
    ["maxFiles", "0"],
    ["maxFiles", "1.5"],
  ])("rejects --%s %p before starting the review", async (flag, value) => {
    // The bad --cwd stops the review before the agent if validation regresses.
    const proc = Bun.spawn(
      [
        "bun",
        "src/cli.ts",
        "review",
        "x",
        `--${flag}`,
        value,
        "--cwd",
        "/nonexistent",
      ],
      {
        env: { PATH: process.env.PATH },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(await proc.exited).not.toBe(0);
    expect(await new Response(proc.stderr).text()).toContain(
      `--${flag} must be a positive integer, not "${value}".`,
    );
  });

  test("leaves --maxTurns unset by default", async () => {
    const proc = Bun.spawn(
      ["bun", "src/cli.ts", "review", "x", "--cwd", "/nonexistent"],
      {
        env: { PATH: process.env.PATH },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(await proc.exited).not.toBe(0);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).not.toContain("must be a positive integer");
    expect(stderr).toContain("Not a git repository: /nonexistent");
  });
});
