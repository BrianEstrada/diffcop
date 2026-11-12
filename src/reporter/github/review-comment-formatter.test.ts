import { describe, expect, test } from "bun:test";
import type { RunStats } from "@/agent/reviewer-agent";
import type { PullRequestContext } from "@/context/github/pull-request-context";
import type {
  DroppedFinding,
  Finding,
  ReviewResult,
  Scope,
  Severity,
} from "@/review/findings";
import {
  ledgerFromComments,
  readLedger,
} from "@/reporter/github/ledger-marker";
import { ReviewCommentFormatter } from "@/reporter/github/review-comment-formatter";
import { readSavedReview } from "@/reporter/github/saved-review-marker";
import type { SavedReview } from "@/review/saved-review";

const pr: PullRequestContext = {
  apiUrl: "https://api.github.test",
  repo: "owner/repo",
  number: 7,
  headSha: "abc1234def",
  title: "Title",
  body: "",
};

const run: PullRequestContext = {
  ...pr,
  runId: "42",
  runUrl: "https://github.com/owner/repo/actions/runs/42",
};

const stats: RunStats = {
  durationMs: 5_000,
  toolCalls: 1,
};

function finding(
  severity: Severity,
  explanation: string,
  scope: Scope = "introduced",
): Finding {
  return {
    file: "src/a.ts",
    startLine: 10,
    endLine: 12,
    severity: severity,
    scope: scope,
    title: `A ${severity} bug`,
    explanation: explanation,
  };
}

// The visible comment: what's left without the marker it ends with.
function visible(body: string) {
  return body.replace(/\n<!-- diffcop:(ledger|saved)=[^>]* -->$/, "");
}

// Text gzip can't shrink, so what's saved is about as long as the text.
function incompressible(chars: number) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(chars)))
    .toString("base64")
    .slice(0, chars);
}

function review(
  findings: Finding[],
  dropped: DroppedFinding[] = [],
): ReviewResult {
  return {
    summary: "",
    findings: findings,
    dropped: dropped,
    explored: {
      filesRead: [],
      searches: [],
    },
    stats: stats,
  };
}

describe("ReviewCommentFormatter.review", () => {
  test("groups the review into collapsible sections under one headline", () => {
    const body = new ReviewCommentFormatter(pr).review({
      ...review(
        [
          finding("nit", "Rename it."),
          finding("high", "Throws on []."),
          finding("medium", "Loops forever.", "preexisting"),
        ],
        [
          {
            finding: finding("low", "Minor."),
            reason: "Guarded by the caller.",
          },
        ],
      ),
      summary: "Traced the parser.",
      explored: {
        filesRead: ["src/a.ts"],
        searches: [
          {
            pattern: "parse",
            path: "src",
          },
        ],
      },
    });
    expect(body).toStartWith(
      [
        "## diffcop review",
        "",
        "🔴 **1 issue, 1 minor finding**",
        "",
        "<details><summary><b>Findings (2)</b></summary>",
        "",
        "| Severity | Location | Issue |",
        "| --- | --- | --- |",
        "| **High** | `src/a.ts:10-12` | **A high bug**<br>Throws on []. |",
        "| **Minor** | `src/a.ts:10-12` | **A nit bug**<br>Rename it. |",
        "",
        "</details>",
        "",
        "<details><summary><b>Outside this PR's scope (1)</b></summary>",
        "",
        "Already wrong before this change, so not blocking it.",
        "",
        "| Severity | Location | Issue |",
        "| --- | --- | --- |",
        "| **Medium** | `src/a.ts:10-12` | **A medium bug**<br>Loops forever. |",
        "",
        "</details>",
        "",
        "<details><summary><b>Dropped by verification (1)</b></summary>",
        "",
        "| Severity | Location | Issue | Verifier |",
        "| --- | --- | --- | --- |",
        "| **Minor** | `src/a.ts:10-12` | **A low bug**<br>Minor. | Guarded by the caller. |",
        "",
        "</details>",
        "",
        "<details><summary><b>What we looked at</b></summary>",
        "",
        "Traced the parser.",
        "",
        "Read (1): `src/a.ts`",
        "",
        "Searched (1): `parse` in `src`",
        "",
        "</details>",
        "",
        "<details><summary><b>Run details</b></summary>",
        "",
        "| Run | Time | Tool calls | Input tokens | Cached | Output | Cost |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| Review | 5s | 1 | – | – | – | – |",
        "",
        "One finder reviewed the whole diff.",
        "",
        "</details>",
        "",
        "---",
        "<sub>Reviewed abc1234",
      ].join("\n"),
    );
  });

  test("counts the minor findings, or says all good, when there are no issues", () => {
    const formatter = new ReviewCommentFormatter(pr);
    expect(formatter.review(review([finding("low", "Minor.")]))).toContain(
      "\n🟡 **1 minor finding**\n\n<details><summary><b>Findings (1)</b></summary>",
    );
    expect(formatter.review(review([]))).toStartWith(
      "## diffcop review\n\n✅ **All good**\n\n<details><summary><b>What we looked at</b></summary>",
    );
  });

  test("puts the stats in the run details, and only the commit and run link in the footer", () => {
    const body = new ReviewCommentFormatter(run).review({
      ...review([]),
      stats: {
        durationMs: 111_000,
        toolCalls: 14,
        inputTokens: 312_000,
        cacheReadTokens: 296_400,
        outputTokens: 4_100,
        costUsd: 0.42,
      },
    });
    const footer = body.split("\n").find((line) => {
      return line.startsWith("<sub>");
    });
    expect(footer).toBe(
      "<sub>Reviewed abc1234 · [run](https://github.com/owner/repo/actions/runs/42)</sub>",
    );
    expect(body).toContain(
      "<details><summary><b>Run details</b></summary>\n\n| Run | Time | Tool calls | Input tokens | Cached | Output | Cost |\n| --- | --- | --- | --- | --- | --- | --- |\n| Review | 1m 51s | 14 | 312K | 95% | 4.1K | ~$0.42 |",
    );
  });

  test("redacts secrets from every section", () => {
    const formatter = new ReviewCommentFormatter(pr, {
      secrets: ["sk-123", undefined, "ghs_456"],
    });
    const body = formatter.review({
      ...review(
        [finding("high", "Found sk-123 and ghs_456 in the env.")],
        [
          {
            finding: finding("low", "Minor."),
            reason: "sk-123 is a test key.",
          },
        ],
      ),
      summary: "Checked where ghs_456 is read.",
      explored: {
        filesRead: ["/home/sk-123/.env"],
        searches: [{ pattern: "ghs_456" }],
      },
    });
    expect(body).toContain("Found *** and *** in the env.");
    expect(body).toContain("| *** is a test key. |");
    expect(body).toContain("Checked where *** is read.");
    expect(body).toContain("Read (1): `/home/***/.env`");
    expect(body).toContain("Searched (1): `***`");
    expect(body).not.toContain("sk-123");
    expect(body).not.toContain("ghs_456");
    expect(JSON.stringify(readSavedReview(body))).not.toMatch(/sk-123|ghs_456/);
  });

  test("redacts a secret JSON would escape from the saved review", () => {
    const formatter = new ReviewCommentFormatter(pr, {
      secrets: ['pa"ss\\word'],
    });
    const body = formatter.review(
      review([finding("high", 'Found pa"ss\\word in the env.')]),
    );
    expect(readSavedReview(body)?.result.findings[0]?.explanation).toBe(
      "Found *** in the env.",
    );
  });

  test("fully redacts a secret that contains another", () => {
    const formatter = new ReviewCommentFormatter(pr, {
      secrets: ["sk-123", "sk-123-extra"],
    });
    const body = formatter.review(
      review([finding("high", "Key sk-123-extra and sk-123.")]),
    );
    expect(body).toContain("Key *** and ***.");
    expect(body).not.toContain("extra");
  });

  test("truncates reviews over GitHub's size limit", () => {
    const body = new ReviewCommentFormatter(pr).review(
      review([finding("high", "x".repeat(70_000))]),
    );
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain(
      "_Review truncated; see the job log for the rest._\n\n</details>",
    );
    expect(body.match(/<details/g)).toHaveLength(2);
    expect(body.match(/<\/details>/g)).toHaveLength(2);
    expect(visible(body)).toEndWith("</sub>");
    expect(readSavedReview(body)?.result.findings[0]?.explanation).toHaveLength(
      70_000,
    );
  });

  test("keeps the run details whole when the review before them is truncated", () => {
    const body = new ReviewCommentFormatter(pr).review({
      ...review(
        [finding("high", "x".repeat(70_000))],
        [
          {
            finding: finding("low", "Minor."),
            reason: "Guarded by the caller.",
          },
        ],
      ),
      finders: [
        {
          files: ["a.ts"],
          chunk: 1,
          lines: 400,
          findings: 1,
          stats: stats,
        },
      ],
      merged: [],
    });

    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("_Review truncated;");
    expect(body).not.toContain("Dropped by verification");
    expect(body).toContain(
      "| Chunk 1 | 1 | 400 | 1 | 5s | 1 | – |\n\n</details>\n\n---\n<sub>Reviewed abc1234",
    );
  });
});

describe("ReviewCommentFormatter saved review", () => {
  const triggered: PullRequestContext = {
    ...run,
    triggerTime: "2026-10-02T10:00:00Z",
  };

  test("saves the review, with its warnings, for a later description re-check", () => {
    const formatter = new ReviewCommentFormatter(triggered);
    formatter.addWarning("Large change.");
    const result = review([finding("low", "Claims a cache.", "description")]);

    const expected: SavedReview = {
      version: 1,
      headSha: "abc1234def",
      descriptionAt: "2026-10-02T10:00:00Z",
      warnings: ["Large change."],
      result: result,
      finders: [],
      merged: 0,
    };
    expect(readSavedReview(formatter.review(result))).toEqual(expected);
  });

  test("saves each finder's numbers, without its file paths or more than a line of its error", () => {
    const result = review([finding("low", "Claims a cache.", "description")]);

    const body = new ReviewCommentFormatter(triggered).review({
      ...result,
      finders: [
        {
          files: ["chunk/one.ts", "chunk/two.ts"],
          chunk: 1,
          lines: 412,
          findings: 1,
          stats: result.stats,
        },
        {
          findings: 0,
          error: `never submitted\n${"install output ".repeat(500)}`,
        },
        {
          findings: 0,
          error: "e".repeat(5_000),
        },
      ],
      merged: [
        {
          finding: finding("low", "Same as the other."),
          into: finding("low", "Claims a cache.", "description"),
        },
      ],
    });

    const encoded = /diffcop:saved=(\S+)/.exec(body)?.[1] ?? "";
    const saved = Buffer.from(
      Bun.gunzipSync(Buffer.from(encoded, "base64")),
    ).toString();
    expect(saved).toContain("Claims a cache.");
    expect(saved).not.toContain("chunk/one.ts");
    expect(saved).not.toContain("Same as the other.");
    expect(readSavedReview(body)?.finders).toEqual([
      {
        files: 2,
        chunk: 1,
        lines: 412,
        findings: 1,
        stats: result.stats,
      },
      {
        findings: 0,
        error: "never submitted",
      },
      {
        findings: 0,
        error: "e".repeat(200),
      },
    ]);
    expect(readSavedReview(body)?.merged).toBe(1);
  });

  test("renders a re-checked review from what was saved, with the re-check as a run of its own", () => {
    const saved: SavedReview = {
      version: 1,
      headSha: "fedcba98765",
      warnings: ["Large change."],
      result: review([]),
      finders: [
        {
          chunk: 1,
          files: 3,
          lines: 400,
          findings: 2,
          stats: stats,
        },
        {
          findings: 0,
          stats: stats,
        },
      ],
      merged: 1,
    };
    const body = new ReviewCommentFormatter(triggered).savedReview(saved, {
      recheck: {
        durationMs: 12_000,
        toolCalls: 3,
      },
    });

    expect(body).toContain("> [!WARNING]\n> Large change.");
    expect(body).toContain("✅ **All good**");
    expect(body).toContain("<sub>Reviewed fedcba9 · [run]");
    expect(body).toContain(
      "| Review | 5s | 1 | – | – | – | – |\n| Description re-check | 12s | 3 | – | – | – | – |",
    );
    expect(body).toContain("| Chunk 1 | 3 | 400 | 2 | 5s | 1 | – |");
    expect(readSavedReview(body)).toEqual(saved);
  });

  test("keeps only the round's findings when the saved review is too long for the comment", () => {
    const body = new ReviewCommentFormatter(triggered).review(
      review([finding("high", incompressible(30_000))]),
    );
    expect(visible(body)).toEndWith("</sub>");
    expect(body.length).toBeLessThan(65_536);
    expect(readSavedReview(body)).toBeUndefined();
    expect(readLedger(body)?.rounds[0]?.entries).toEqual([
      {
        ...finding("high", "trimmed"),
        explanation: undefined,
        status: "reported",
      },
    ]);
  });
});

describe("ReviewCommentFormatter failure", () => {
  test("links to the run log", () => {
    expect(new ReviewCommentFormatter(run).failure(new Error("x"))).toContain(
      "[See the run log](https://github.com/owner/repo/actions/runs/42)",
    );
  });

  test("failure shows the error in a code block", () => {
    const body = new ReviewCommentFormatter(run).failure(
      new Error("rate limited\n```oops"),
    );
    expect(body).toContain("❌ The review of `abc1234` failed.");
    expect(body).toContain("```\nrate limited\n'''oops\n```");
  });

  test("failure redacts secrets from the error", () => {
    const formatter = new ReviewCommentFormatter(run, {
      secrets: ["sk-123", undefined, "", "ghs_456"],
    });
    const body = formatter.failure(
      new Error("401 for key sk-123 (token ghs_456)"),
    );
    expect(body).toContain("401 for key *** (token ***)");
    expect(body).not.toContain("sk-123");
    expect(body).not.toContain("ghs_456");
  });
});

describe("ReviewCommentFormatter warnings", () => {
  const alert = "> [!WARNING]\n> This change is large.\n\n";

  function warned() {
    const formatter = new ReviewCommentFormatter(run);
    formatter.addWarning("This change is large.");
    return formatter;
  }

  test("leave the comment alone when there are none", () => {
    expect(new ReviewCommentFormatter(run).review(review([]))).not.toContain(
      "[!WARNING]",
    );
  });

  test("open the review", () => {
    expect(warned().review(review([]))).toStartWith(
      `## diffcop review\n\n${alert}✅ **All good**`,
    );
  });

  test("open the failure", () => {
    expect(warned().failure(new Error("boom"))).toStartWith(
      `## diffcop review\n\n${alert}❌ The review`,
    );
  });

  test("each get their own alert", () => {
    const formatter = warned();
    formatter.addWarning("Another one.");
    expect(formatter.review(review([]))).toContain(
      `${alert}> [!WARNING]\n> Another one.\n\n✅`,
    );
  });
});

describe("ReviewCommentFormatter memory", () => {
  test("a review's comment remembers its round", () => {
    const body = new ReviewCommentFormatter(pr).review(
      review(
        [finding("high", "Throws on [].")],
        [
          {
            finding: finding("low", "Minor."),
            reason: "Guarded by the caller.",
          },
        ],
      ),
    );

    expect(body).not.toContain("diffcop:ledger");
    expect(ledgerFromComments([body])).toEqual({
      version: 1,
      rounds: [
        {
          headSha: "abc1234def",
          entries: [
            {
              ...finding("high", "Throws on []."),
              status: "reported",
            },
            {
              ...finding("low", "Minor."),
              status: "dropped",
              reason: "Guarded by the caller.",
            },
          ],
          complete: true,
        },
      ],
    });
  });

  test("a failed review's comment remembers nothing", () => {
    const body = new ReviewCommentFormatter(pr).failure(
      new Error("rate limited"),
    );

    expect(body).not.toContain("<!-- diffcop:");
    expect(ledgerFromComments([body])).toBeUndefined();
  });

  test("redacts secrets from what it remembers", () => {
    const formatter = new ReviewCommentFormatter(pr, { secrets: ["sk-123"] });

    const saved = formatter.review(
      review([finding("high", "Found sk-123 in the env.")]),
    );
    // Too long to save whole, so only the round is kept, without its explanations.
    const roundOnly = formatter.review(
      review(
        [finding("high", incompressible(30_000))],
        [
          {
            finding: finding("low", "Minor."),
            reason: "Guarded by sk-123.",
          },
        ],
      ),
    );

    expect(saved).not.toContain("diffcop:ledger");
    expect(
      ledgerFromComments([saved])?.rounds[0]?.entries[0]?.explanation,
    ).toBe("Found *** in the env.");
    expect(roundOnly).not.toContain("diffcop:saved");
    expect(ledgerFromComments([roundOnly])?.rounds[0]?.entries[1]?.reason).toBe(
      "Guarded by ***.",
    );
  });

  test("makes room for what it remembers by truncating the visible review sooner", () => {
    const body = new ReviewCommentFormatter(pr).review(
      review([
        finding("high", `${incompressible(12_000)}${"x".repeat(60_000)}`),
      ]),
    );

    expect(body.length).toBeLessThan(65_536);
    expect(visible(body).length).toBeLessThan(50_000);
    expect(visible(body)).toContain("_Review truncated;");
    expect(readSavedReview(body)?.result.findings[0]?.explanation).toHaveLength(
      72_000,
    );
  });

  test("says under the headline what became of the last round's findings", () => {
    const body = new ReviewCommentFormatter(pr).review({
      ...review([finding("high", "Still throws."), finding("nit", "New.")]),
      rereview: {
        since: "1111111222",
        settled: [],
        fixed: [
          {
            finding: finding("low", "Was off by one."),
            reason: "The bound is inclusive now.",
          },
        ],
        stillOpen: 1,
        leftOut: 0,
      },
    });

    expect(body).toContain(
      "🔴 **1 issue, 1 minor finding**\n\nSince `1111111`: 1 fixed, 1 still open, 1 new.\n\n<details><summary><b>Findings (2)</b></summary>",
    );
    expect(body).toContain(
      "<details><summary><b>Fixed since the last review (1)</b></summary>",
    );
    expect(body).toContain("The bound is inclusive now.");
  });

  test("says in the footer which commit a re-review focused on changes since", () => {
    const body = new ReviewCommentFormatter(pr).review({
      ...review([]),
      rereview: {
        since: "1111111222",
        settled: [],
        leftOut: 0,
      },
    });

    expect(body).toContain(
      "<sub>Reviewed abc1234, focused on changes since 1111111</sub>",
    );
  });

  test("saves what a re-review settled, so a description re-check renders it again", () => {
    const rereview = {
      since: "1111111222",
      settled: [
        {
          finding: finding("nit", "Rename it."),
          reason: "Declined in round 1.",
        },
      ],
      leftOut: 3,
    };

    const body = new ReviewCommentFormatter(pr).review({
      ...review([]),
      rereview: rereview,
    });

    expect(body).toContain("<b>Settled in an earlier round (1)</b>");
    expect(readSavedReview(body)?.result.rereview).toEqual(rereview);
    expect(ledgerFromComments([body])?.rounds[0]?.entries).toEqual([
      {
        ...finding("nit", "Rename it."),
        status: "settled",
        reason: "Declined in round 1.",
      },
    ]);
  });
});
