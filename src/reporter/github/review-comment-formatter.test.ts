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
import { readLedger } from "@/reporter/github/ledger-marker";
import { ReviewCommentFormatter } from "@/reporter/github/review-comment-formatter";
import { readSavedReview } from "@/reporter/github/saved-review-marker";
import type { ReviewLedger } from "@/review/review-ledger";
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

// The visible comment: what's left without the ledger it ends with.
function withoutLedger(body: string) {
  return body.replace(/\n<!-- diffcop:ledger=[^>]* -->$/, "");
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
        "🔴 **1 issue found**",
        "",
        "<details open><summary><b>Issues (1)</b></summary>",
        "",
        "| Severity | Location | Issue |",
        "| --- | --- | --- |",
        "| **High** | `src/a.ts:10-12` | **A high bug**<br>Throws on []. |",
        "",
        "</details>",
        "",
        "<details><summary><b>Nits (1)</b></summary>",
        "",
        "| Severity | Location | Issue |",
        "| --- | --- | --- |",
        "| **Nit** | `src/a.ts:10-12` | **A nit bug**<br>Rename it. |",
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
        "| **Low** | `src/a.ts:10-12` | **A low bug**<br>Minor. | Guarded by the caller. |",
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
        "---",
        "<sub>Reviewed abc1234",
      ].join("\n"),
    );
  });

  test("says only nits or all good when there are no issues", () => {
    const formatter = new ReviewCommentFormatter(pr);
    expect(formatter.review(review([finding("low", "Minor.")]))).toContain(
      "\n🟡 **Only nits**\n\n<details><summary><b>Nits (1)</b></summary>",
    );
    expect(formatter.review(review([]))).toStartWith(
      "## diffcop review\n\n✅ **All good**\n\n<details><summary><b>What we looked at</b></summary>",
    );
  });

  test("puts stats and the run link in the footer", () => {
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
      "<sub>Reviewed abc1234 · 1m 51s · 14 tool calls · 312K input tokens (95% cached) · 4.1K output · ~$0.42 [run](https://github.com/owner/repo/actions/runs/42)</sub>",
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
    expect(body.match(/<details/g)).toHaveLength(1);
    expect(body.match(/<\/details>/g)).toHaveLength(1);
    expect(withoutLedger(body)).toEndWith("</sub>");
    expect(readSavedReview(body)).toBeUndefined();
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
    };
    expect(readSavedReview(formatter.review(result))).toEqual(expected);
  });

  test("leaves the per-finder detail out of the saved review", () => {
    const result = review([finding("low", "Claims a cache.", "description")]);

    const body = new ReviewCommentFormatter(triggered).review({
      ...result,
      finders: [
        {
          files: ["a.ts"],
          findings: 1,
          stats: result.stats,
        },
      ],
      merged: [],
    });

    const encoded = /diffcop:saved=(\S+)/.exec(body)?.[1] ?? "";
    const saved = Buffer.from(encoded, "base64").toString("utf8");
    expect(saved).toContain("Claims a cache.");
    expect(saved).not.toContain('"finders"');
    expect(saved).not.toContain('"merged"');
  });

  test("renders a re-checked review from what was saved, beside the re-check's stats", () => {
    const saved: SavedReview = {
      version: 1,
      headSha: "fedcba98765",
      warnings: ["Large change."],
      result: review([]),
    };
    const body = new ReviewCommentFormatter(triggered).savedReview(saved, {
      recheck: {
        durationMs: 12_000,
        toolCalls: 3,
      },
    });

    expect(body).toContain("> [!WARNING]\n> Large change.");
    expect(body).toContain("✅ **All good**");
    expect(body).toContain(
      "<sub>Reviewed fedcba9 · 5s · 1 tool call · description re-checked in 12s · 3 tool calls [run]",
    );
    expect(readSavedReview(body)).toEqual(saved);
  });

  test("leaves the saved review out when it would push the comment past GitHub's limit", () => {
    const body = new ReviewCommentFormatter(triggered).review(
      review([finding("high", "x".repeat(40_000))]),
    );
    expect(withoutLedger(body)).toEndWith("</sub>");
    expect(body.length).toBeLessThan(65_000);
    expect(readSavedReview(body)).toBeUndefined();
    expect(readLedger(body)?.rounds).toHaveLength(1);
  });
});

describe("ReviewCommentFormatter status", () => {
  test("running links to the run", () => {
    expect(new ReviewCommentFormatter(run).running()).toContain(
      "⏳ Reviewing `abc1234`… [Follow the run](https://github.com/owner/repo/actions/runs/42)",
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

  test("cancellation says so instead of showing an error", () => {
    const body = new ReviewCommentFormatter(run).failure(new Error("aborted"), {
      cancelled: true,
    });
    expect(body).toContain("was cancelled before it finished");
    expect(body).not.toContain("aborted");
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
    expect(new ReviewCommentFormatter(run).running()).not.toContain(
      "[!WARNING]",
    );
  });

  test("open the running status", () => {
    expect(warned().running()).toStartWith(
      `## diffcop review\n\n${alert}⏳ Reviewing`,
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
    expect(formatter.running()).toContain(
      `${alert}> [!WARNING]\n> Another one.\n\n⏳`,
    );
  });
});

describe("ReviewCommentFormatter ledger", () => {
  const earlier: ReviewLedger = {
    version: 1,
    rounds: [
      {
        headSha: "1111111",
        entries: [
          {
            ...finding("nit", "Rename it."),
            status: "dropped",
            reason: "The sibling file uses the same name.",
          },
        ],
      },
    ],
  };

  // Text gzip can't shrink, so the ledger's size is close to the text's.
  function incompressible(chars: number) {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(chars))).toString(
      "base64",
    );
  }

  test("starts a ledger with the first review's round", () => {
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

    expect(readLedger(body)).toEqual({
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
        },
      ],
    });
  });

  test("adds the review's round after the earlier ones", () => {
    const formatter = new ReviewCommentFormatter(pr);
    formatter.setLedger(earlier);

    const rounds = readLedger(formatter.review(review([])))?.rounds ?? [];

    expect(
      rounds.map(({ headSha }) => {
        return headSha;
      }),
    ).toEqual(["1111111", "abc1234def"]);
    expect(rounds[0]).toEqual(earlier.rounds[0]);
  });

  test("carries the earlier rounds through the running, failed and cancelled statuses", () => {
    const formatter = new ReviewCommentFormatter(pr);
    formatter.setLedger(earlier);

    for (const body of [
      formatter.running(),
      formatter.failure(new Error("rate limited")),
      formatter.failure(new Error("aborted"), { cancelled: true }),
    ]) {
      expect(readLedger(body)).toEqual(earlier);
    }
  });

  test("leaves the statuses alone on a PR's first review", () => {
    expect(new ReviewCommentFormatter(pr).running()).not.toContain(
      "diffcop:ledger",
    );
  });

  test("redacts secrets from the ledger", () => {
    const formatter = new ReviewCommentFormatter(pr, { secrets: ["sk-123"] });

    const body = formatter.review(
      review([finding("high", "Found sk-123 in the env.")]),
    );

    expect(readLedger(body)?.rounds[0]?.entries[0]?.explanation).toBe(
      "Found *** in the env.",
    );
  });

  test("makes room for the ledger by truncating the visible review sooner", () => {
    const formatter = new ReviewCommentFormatter(pr);
    formatter.setLedger({
      version: 1,
      rounds: [
        {
          headSha: "1111111",
          entries: [
            {
              ...finding("nit", incompressible(8_000)),
              status: "reported",
            },
          ],
        },
      ],
    });

    const body = formatter.review(
      review([finding("high", "x".repeat(70_000))]),
    );

    expect(body.length).toBeLessThan(65_536);
    expect(withoutLedger(body)).toContain("_Review truncated;");
    expect(readLedger(body)?.rounds).toHaveLength(2);
  });

  test("trims a ledger that outgrows its share of the comment, oldest explanations first", () => {
    const formatter = new ReviewCommentFormatter(pr);
    formatter.setLedger({
      version: 1,
      rounds: ["1111111", "2222222"].map((headSha) => {
        return {
          headSha: headSha,
          entries: [
            {
              ...finding("nit", incompressible(9_000)),
              status: "dropped" as const,
              reason: "Deliberate.",
            },
          ],
        };
      }),
    });

    const ledger = readLedger(formatter.running());

    expect(formatter.running().length).toBeLessThan(21_000);
    expect(ledger?.rounds).toHaveLength(2);
    expect(ledger?.rounds[0]?.entries[0]?.explanation).toBeUndefined();
    expect(ledger?.rounds[0]?.entries[0]?.reason).toBe("Deliberate.");
    expect(ledger?.rounds[1]?.entries[0]?.explanation).toBeDefined();
  });

  test("keeps the ledger ahead of the saved review when both don't fit", () => {
    const body = new ReviewCommentFormatter(pr).review(
      review([finding("high", incompressible(26_000))]),
    );

    expect(body.length).toBeLessThan(65_000);
    expect(readSavedReview(body)).toBeUndefined();
    expect(readLedger(body)?.rounds).toHaveLength(1);
  });

  test("keeps a ledger passed with a re-checked review as it is", () => {
    const saved: SavedReview = {
      version: 1,
      headSha: "fedcba98765",
      warnings: [],
      result: review([]),
    };

    const body = new ReviewCommentFormatter(pr).savedReview(saved, {
      ledger: earlier,
    });

    expect(readLedger(body)).toEqual(earlier);
    expect(readSavedReview(body)).toEqual(saved);
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
      "<sub>Reviewed abc1234, focused on changes since 1111111 · 5s · 1 tool call</sub>",
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
    expect(readLedger(body)?.rounds[0]?.entries).toEqual([
      {
        ...finding("nit", "Rename it."),
        status: "settled",
        reason: "Declined in round 1.",
      },
    ]);
  });
});
