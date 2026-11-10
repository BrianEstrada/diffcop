import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerFile } from "@/review/ledger-file";
import type { ReviewLedger } from "@/review/review-ledger";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "diffcop-ledger-"));
});

afterAll(async () => {
  await rm(dir, {
    recursive: true,
    force: true,
  });
});

const ledger: ReviewLedger = {
  version: 1,
  rounds: [
    {
      headSha: "aaaaaaa",
      entries: [
        {
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          severity: "low",
          scope: "introduced",
          title: "A",
          status: "reported",
          answer: "Won't fix: the other handlers do the same.",
        },
      ],
    },
  ],
};

describe("LedgerFile", () => {
  test("loads nothing from a file that doesn't exist yet", async () => {
    expect(await new LedgerFile(join(dir, "missing.json")).load()).toBe(
      undefined,
    );
  });

  test("loads what it saved, answers included", async () => {
    const file = new LedgerFile(join(dir, "ledger.json"));
    await file.save(ledger);

    expect(await file.load()).toEqual(ledger);
  });

  test.each([
    ["not-json.json", "not json"],
    ["other.json", '{"rounds": "none"}'],
  ])("rejects %s, which isn't a ledger", async (name, content) => {
    const path = join(dir, name);
    await Bun.write(path, content);

    expect(new LedgerFile(path).load()).rejects.toThrow(
      `${path} isn't a diffcop ledger.`,
    );
  });
});
