import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepository } from "./git-repository";

let dir: string;

async function git(...args: string[]) {
  // Pin identity and disable signing so the user's git config can't break setup.
  await $`git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false ${args}`
    .cwd(dir)
    .quiet();
}

beforeAll(async () => {
  // Git hooks export GIT_DIR and friends, which would point these commands at
  // diffcop's own repository instead of the fixture.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) {
      Reflect.deleteProperty(process.env, key);
    }
  }

  dir = await realpath(await mkdtemp(join(tmpdir(), "diffcop-git-")));
  await git("init", "-q", "-b", "main");
  await Bun.write(join(dir, "a.txt"), "one\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "initial");
  await git("checkout", "-q", "-b", "feature");
  await Bun.write(join(dir, "a.txt"), "one\ntwo\n");
  await git("commit", "-q", "-am", "add two");
  // Uncommitted edit: must still show up in the diff.
  await Bun.write(join(dir, "b.txt"), "new\n");
  await git("add", "b.txt");
});

afterAll(async () => {
  await rm(dir, {
    recursive: true,
    force: true,
  });
});

describe("GitRepository", () => {
  test("root resolves the top level from a subdirectory", async () => {
    await $`mkdir -p ${join(dir, "nested")}`;
    const repository = new GitRepository(join(dir, "nested"));
    expect(await repository.root()).toBe(dir);
  });

  test("root rejects a directory outside any repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "diffcop-nogit-"));
    try {
      expect(new GitRepository(outside).root()).rejects.toThrow(
        `Not a git repository: ${outside}`,
      );
    } finally {
      await rm(outside, {
        recursive: true,
        force: true,
      });
    }
  });

  test("defaultBase rejects outside a repository instead of falling back", async () => {
    const outside = await mkdtemp(join(tmpdir(), "diffcop-nogit-"));
    try {
      expect(new GitRepository(outside).defaultBase()).rejects.toThrow(
        "Not a git repository",
      );
    } finally {
      await rm(outside, {
        recursive: true,
        force: true,
      });
    }
  });

  test("defaultBase falls back to main without origin/HEAD", async () => {
    const repository = new GitRepository(dir);
    expect(await repository.defaultBase()).toBe("main");
  });

  test("reads branch, commits, changed files and diff since the merge base", async () => {
    const repository = new GitRepository(dir);
    const mergeBase = await repository.mergeBase("main");

    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);
    expect(await repository.currentBranch()).toBe("feature");

    const commits = await repository.commitsSince(mergeBase);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEndWith(" add two");

    expect(await repository.changedFilesSince(mergeBase)).toEqual([
      {
        path: "a.txt",
        additions: 1,
        deletions: 0,
      },
      {
        path: "b.txt",
        additions: 1,
        deletions: 0,
      },
    ]);

    const diff = await repository.diffSince(mergeBase);
    expect(diff).toContain("+two");
    expect(diff).toContain("+new");
  });

  test("mergeBase rejects an unknown ref", async () => {
    const repository = new GitRepository(dir);
    expect(repository.mergeBase("no-such-ref")).rejects.toThrow();
  });
});
