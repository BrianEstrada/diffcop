import { afterAll, describe, expect, test } from "bun:test";
import type { JSONType } from "@/util/json";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPullRequestContext } from "@/context/github/pull-request-context";

const dir = await mkdtemp(join(tmpdir(), "diffcop-pr-"));
afterAll(() => {
  return rm(dir, {
    recursive: true,
    force: true,
  });
});

async function writeEvent(name: string, event: JSONType) {
  const path = join(dir, name);
  await Bun.write(path, JSON.stringify(event));
  return path;
}

describe("readPullRequestContext", () => {
  test("reads the PR from a pull_request event", async () => {
    const path = await writeEvent("pr.json", {
      action: "synchronize",
      pull_request: {
        number: 7,
        title: "Add a thing",
        body: "Why it's needed",
        created_at: "2026-10-01T10:00:00Z",
        updated_at: "2026-10-02T10:00:00Z",
        base: { ref: "main" },
        head: { sha: "abc1234def" },
      },
    });
    const context = await readPullRequestContext({
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_PATH: path,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_RUN_ID: "42",
    });
    expect(context).toEqual({
      apiUrl: "https://api.github.test",
      repo: "owner/repo",
      number: 7,
      headSha: "abc1234def",
      title: "Add a thing",
      body: "Why it's needed",
      action: "synchronize",
      triggerTime: "2026-10-02T10:00:00Z",
      runId: "42",
      runUrl: "https://github.com/owner/repo/actions/runs/42",
    });
  });

  test("uses an opened PR's creation time as the trigger time", async () => {
    const path = await writeEvent("opened.json", {
      action: "opened",
      pull_request: {
        number: 7,
        title: "Add a thing",
        body: null,
        created_at: "2026-10-01T10:00:00Z",
        updated_at: "2026-10-01T10:00:05Z",
        base: { ref: "main" },
        head: { sha: "abc1234def" },
      },
    });
    const context = await readPullRequestContext({
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_PATH: path,
      GITHUB_REPOSITORY: "owner/repo",
    });
    expect(context).toMatchObject({
      body: "",
      triggerTime: "2026-10-01T10:00:00Z",
    });
  });

  test("returns undefined outside GitHub Actions", async () => {
    expect(await readPullRequestContext({})).toBeUndefined();
  });

  test("returns undefined for events without a pull request", async () => {
    const path = await writeEvent("push.json", { ref: "refs/heads/main" });
    const context = await readPullRequestContext({
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_PATH: path,
      GITHUB_REPOSITORY: "owner/repo",
    });
    expect(context).toBeUndefined();
  });

  test("returns undefined for a malformed event payload", async () => {
    const path = join(dir, "malformed.json");
    await Bun.write(path, '{"pull_request": {');
    const context = await readPullRequestContext({
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_PATH: path,
      GITHUB_REPOSITORY: "owner/repo",
    });
    expect(context).toBeUndefined();
  });
});
