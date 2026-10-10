import { describe, expect, test } from "bun:test";
import type { RunStats } from "../../agent/reviewer-agent";
import type { PullRequestContext } from "../../context/github/pull-request-context";
import type {
  DroppedFinding,
  Finding,
  ReviewResult,
  Scope,
  Severity,
} from "../../review/findings";
import { ReviewCommentFormatter } from "./review-comment-formatter";

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
    expect(body.split("\n").at(-1)).toBe(
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
    expect(body).toEndWith("</sub>");
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
