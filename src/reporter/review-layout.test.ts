import { describe, expect, test } from "bun:test";
import type { Explored } from "@/agent/explored";
import type { DroppedFinding, Finding, Rereview } from "@/review/findings";
import { code, reviewLayout, sectionHeading } from "@/reporter/review-layout";

const low: Finding = {
  file: "src/b.ts",
  startLine: 3,
  endLine: 3,
  severity: "low",
  scope: "introduced",
  title: "Off-by-one in the page count",
  explanation: "With 10 items and a page size of 5, it reports 3 pages.",
};

const high: Finding = {
  file: "src/a.ts",
  startLine: 10,
  endLine: 12,
  severity: "high",
  scope: "introduced",
  title: "Crashes on an empty list",
  explanation: "`items[0].id` throws when `items` is [].\nSee src/a.ts:11.",
};

const medium: Finding = {
  ...high,
  severity: "medium",
  title: "Loses the last page",
};

const nit: Finding = {
  ...low,
  severity: "nit",
  title: "`n` could be `pageCount`",
  explanation: "The name says what it counts.",
};

const old: Finding = {
  ...high,
  scope: "preexisting",
  title: "Retries forever on a 404",
};

const mismatch: Finding = {
  ...high,
  severity: "medium",
  scope: "description",
  title: "Says retries were added, but none were",
  explanation:
    'The description says "retries failed uploads", but `upload` still calls `fetch` once.',
};

const nothingExplored: Explored = {
  filesRead: [],
  searches: [],
};

function layout(
  findings: Finding[],
  {
    dropped = [],
    summary = "",
    explored = nothingExplored,
  }: {
    dropped?: DroppedFinding[];
    summary?: string;
    explored?: Explored;
  } = {},
) {
  return reviewLayout({
    summary: summary,
    findings: findings,
    dropped: dropped,
    explored: explored,
  });
}

function titles(findings: Finding[], dropped: DroppedFinding[] = []) {
  return layout(findings, { dropped: dropped }).sections.map(sectionHeading);
}

function section(title: string, findings: Finding[], summary = "") {
  return layout(findings, { summary: summary }).sections.find((s) => {
    return s.title === title;
  });
}

describe("reviewLayout headline", () => {
  test("counts introduced high and medium findings as issues, and the rest as minor", () => {
    expect(layout([high, medium, low, nit]).headline).toEqual({
      icon: "🔴",
      text: "2 issues, 2 minor findings",
      blocking: true,
    });
    expect(layout([medium, nit]).headline.text).toBe(
      "1 issue, 1 minor finding",
    );
  });

  test("says issues were found when they're all there is", () => {
    expect(layout([high, medium]).headline.text).toBe("2 issues found");
    expect(layout([medium]).headline.text).toBe("1 issue found");
  });

  test("counts minor findings without blocking on them", () => {
    expect(layout([low, nit]).headline).toEqual({
      icon: "🟡",
      text: "2 minor findings",
      blocking: false,
    });
    expect(layout([nit, old]).headline.text).toBe("1 minor finding");
  });

  test("blocks on a description mismatch, named after any issues", () => {
    expect(layout([mismatch, nit]).headline).toEqual({
      icon: "🔴",
      text: "Description doesn't match the diff, 1 minor finding",
      blocking: true,
    });
    expect(layout([mismatch]).headline).toEqual({
      icon: "🔴",
      text: "Description doesn't match the diff",
      blocking: true,
    });
    expect(layout([mismatch, high]).headline).toEqual({
      icon: "🔴",
      text: "1 issue, description doesn't match the diff",
      blocking: true,
    });
  });

  test("is all good when nothing was introduced, whatever was already wrong", () => {
    expect(layout([]).headline).toEqual({
      icon: "✅",
      text: "All good",
      blocking: false,
    });
    expect(layout([old]).headline.text).toBe("All good");
  });
});

describe("reviewLayout sections", () => {
  test("come in a fixed order, with every reported finding under Findings", () => {
    const { sections } = layout([nit, old, mismatch, high], {
      dropped: [
        {
          finding: low,
          reason: "Guarded.",
        },
      ],
    });
    expect(sections.map(sectionHeading)).toEqual([
      "Findings (3)",
      "Outside this PR's scope (1)",
      "Dropped by verification (1)",
      "What we looked at",
    ]);
  });

  test("leave out every empty section but What we looked at", () => {
    expect(titles([])).toEqual(["What we looked at"]);
    expect(titles([low, nit])).toEqual(["Findings (2)", "What we looked at"]);
    expect(titles([old])).toEqual([
      "Outside this PR's scope (1)",
      "What we looked at",
    ]);
  });

  test("list findings in one table: issues most severe first, then the description, then the minor ones", () => {
    expect(section("Findings", [nit, mismatch, medium, low, high])?.body).toBe(
      [
        "| Severity | Location | Issue |",
        "| --- | --- | --- |",
        "| **High** | `src/a.ts:10-12` | **Crashes on an empty list**<br>`items[0].id` throws when `items` is [].<br>See src/a.ts:11. |",
        "| **Medium** | `src/a.ts:10-12` | **Loses the last page**<br>`items[0].id` throws when `items` is [].<br>See src/a.ts:11. |",
        '| **Description** | `src/a.ts:10-12` | **Says retries were added, but none were**<br>The description says "retries failed uploads", but `upload` still calls `fetch` once. |',
        "| **Minor** | `src/b.ts:3` | **Off-by-one in the page count**<br>With 10 items and a page size of 5, it reports 3 pages. |",
        "| **Minor** | `src/b.ts:3` | **`n` could be `pageCount`**<br>The name says what it counts. |",
      ].join("\n"),
    );
  });

  test("escape pipes so a cell can't split the table", () => {
    const piped = {
      ...nit,
      title: "a || b",
      explanation: "x | y",
    };
    expect(section("Findings", [piped])?.body).toEndWith(
      "| **a \\|\\| b**<br>x \\| y |",
    );
  });

  test("keep the terminal table narrow and list explanations below it", () => {
    const dropped = reviewLayout(
      {
        summary: "",
        findings: [],
        dropped: [
          {
            finding: low,
            reason: "No verdict returned",
          },
          {
            finding: high,
            reason: "Guarded by the caller.",
          },
        ],
        explored: nothingExplored,
      },
      { html: false },
    ).sections[0];
    expect(dropped?.body).toBe(
      [
        "| # | Severity | Location | Title |",
        "| --- | --- | --- | --- |",
        "| 1 | **High** | `src/a.ts:10-12` | Crashes on an empty list |",
        "| 2 | **Minor** | `src/b.ts:3` | Off-by-one in the page count |",
        "",
        "1. `items[0].id` throws when `items` is [].",
        "   See src/a.ts:11.",
        "",
        "   Verifier: Guarded by the caller.",
        "2. With 10 items and a page size of 5, it reports 3 pages.",
        "",
        "   Verifier: No verdict returned",
      ].join("\n"),
    );
  });

  test("explain why preexisting findings don't block the PR", () => {
    expect(section("Outside this PR's scope", [old])?.body).toBe(
      [
        "Already wrong before this change, so not blocking it.",
        "",
        "| Severity | Location | Issue |",
        "| --- | --- | --- |",
        "| **High** | `src/a.ts:10-12` | **Retries forever on a 404**<br>`items[0].id` throws when `items` is [].<br>See src/a.ts:11. |",
      ].join("\n"),
    );
  });

  test("give the verifier's reason for each dropped finding", () => {
    const dropped = layout([], {
      dropped: [
        {
          finding: low,
          reason: "No verdict returned",
        },
        {
          finding: high,
          reason: "Guarded by\nthe caller.",
        },
      ],
    }).sections[0];
    expect(dropped?.title).toBe("Dropped by verification");
    expect(dropped?.body).toBe(
      [
        "| Severity | Location | Issue | Verifier |",
        "| --- | --- | --- | --- |",
        "| **High** | `src/a.ts:10-12` | **Crashes on an empty list**<br>`items[0].id` throws when `items` is [].<br>See src/a.ts:11. | Guarded by<br>the caller. |",
        "| **Minor** | `src/b.ts:3` | **Off-by-one in the page count**<br>With 10 items and a page size of 5, it reports 3 pages. | No verdict returned |",
      ].join("\n"),
    );
  });
});

describe("reviewLayout What we looked at", () => {
  function lookedAt(summary: string, explored: Explored) {
    return layout([], {
      summary: summary,
      explored: explored,
    }).sections.at(-1)?.body;
  }

  test("shows the summary, the files read and the searches", () => {
    expect(
      lookedAt(" Traced sumStats into both reporters. ", {
        filesRead: ["src/a.ts", "src/b.ts"],
        searches: [
          {
            pattern: "sumStats",
            path: "src",
          },
          { pattern: "**/*.test.ts" },
        ],
      }),
    ).toBe(
      [
        "Traced sumStats into both reporters.",
        "",
        "Read (2): `src/a.ts`, `src/b.ts`",
        "",
        "Searched (2): `sumStats` in `src`, `**/*.test.ts`",
      ].join("\n"),
    );
  });

  test("caps long lists", () => {
    const filesRead = Array.from({ length: 32 }, (_, i) => {
      return `f${i}.ts`;
    });
    const body = lookedAt("", {
      filesRead: filesRead,
      searches: [],
    });
    expect(body).toStartWith("Read (32): `f0.ts`, `f1.ts`");
    expect(body).toEndWith("`f29.ts` and 2 more");
    expect(body).not.toContain("f30.ts");
  });

  test("says so when nothing was recorded", () => {
    expect(lookedAt("", nothingExplored)).toBe("Nothing recorded.");
  });
});

describe("code", () => {
  test("fences text that has backticks with a longer run", () => {
    expect(code("a.ts")).toBe("`a.ts`");
    expect(code("x`y")).toBe("`` x`y ``");
    expect(code("```")).toBe("```` ``` ````");
  });
});

describe("reviewLayout on a re-review", () => {
  function rereviewed(leftOut: number, since?: string) {
    return reviewLayout({
      summary: "Traced the handler.",
      findings: [high],
      dropped: [],
      explored: nothingExplored,
      rereview: {
        ...(since !== undefined && { since: since }),
        settled: [
          {
            finding: nit,
            reason: "Declined in round 1: the other handlers do the same.",
          },
        ],
        leftOut: leftOut,
      },
    });
  }

  test("lists settled findings in a section of their own, with what settled them", () => {
    const { headline, sections } = rereviewed(0);
    const settled = sections.find((s) => {
      return s.title === "Settled in an earlier round";
    });

    expect(headline.text).toBe("1 issue found");
    expect(sections.map(sectionHeading)).toEqual([
      "Findings (1)",
      "Settled in an earlier round (1)",
      "What we looked at",
    ]);
    expect(settled?.body).toContain(
      "Declined in round 1: the other handlers do the same.",
    );
  });

  function progress(
    findings: Finding[],
    rereview: Partial<Rereview>,
  ): string | undefined {
    return reviewLayout({
      summary: "",
      findings: findings,
      dropped: [],
      explored: nothingExplored,
      rereview: {
        settled: [],
        leftOut: 0,
        ...rereview,
      },
    }).progress;
  }

  const gone = {
    finding: low,
    reason: "The page count rounds up now.",
  };

  test("says what became of the last round's findings", () => {
    expect(
      progress([high, nit, medium], {
        since: "aaaaaaa1234",
        fixed: [gone],
        settled: [gone],
        stillOpen: 2,
      }),
    ).toBe("Since `aaaaaaa`: 1 fixed, 1 settled, 2 still open, 1 new.");
  });

  test("leaves out the counts that are zero", () => {
    expect(
      progress([high], {
        since: "aaaaaaa1234",
        fixed: [],
        stillOpen: 1,
      }),
    ).toBe("Since `aaaaaaa`: 1 still open.");
  });

  test("doesn't count a description mismatch as new, since it's checked afresh each round", () => {
    expect(
      progress([mismatch, high], {
        fixed: [],
        stillOpen: 1,
      }),
    ).toBe("Since the last review: 1 still open.");
  });

  test("says nothing when there's nothing to tell, or on a round from before findings were carried over", () => {
    expect(progress([], { fixed: [] })).toBeUndefined();
    expect(progress([high], {})).toBeUndefined();
    expect(layout([high]).progress).toBeUndefined();
  });

  test("lists what was fixed with the verifier's reason", () => {
    const { sections } = reviewLayout({
      summary: "",
      findings: [],
      dropped: [],
      explored: nothingExplored,
      rereview: {
        settled: [],
        fixed: [gone],
        stillOpen: 0,
        leftOut: 0,
      },
    });

    expect(sections.map(sectionHeading)).toEqual([
      "Fixed since the last review (1)",
      "What we looked at",
    ]);
    expect(sections[0]?.body).toContain("The page count rounds up now.");
  });

  test("says how many minor findings were left out, and since which commit", () => {
    expect(rereviewed(2, "abc1234def").sections.at(-1)?.body).toBe(
      "Traced the handler.\n\nLeft out 2 minor findings on code that hasn't changed since `abc1234`, the last commit reviewed.",
    );
    expect(rereviewed(1, "abc1234def").sections.at(-1)?.body).toContain(
      "Left out 1 minor finding on",
    );
  });

  test("says nothing of left-out findings when there are none", () => {
    expect(rereviewed(0, "abc1234def").sections.at(-1)?.body).toBe(
      "Traced the handler.",
    );
  });

  test("has no settled section when nothing was settled", () => {
    const { sections } = reviewLayout({
      summary: "",
      findings: [],
      dropped: [],
      explored: nothingExplored,
      rereview: {
        settled: [],
        leftOut: 0,
      },
    });

    expect(sections.map(sectionHeading)).toEqual(["What we looked at"]);
  });
});
