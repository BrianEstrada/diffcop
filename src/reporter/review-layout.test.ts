import { describe, expect, test } from "bun:test";
import type { Explored } from "../agent/explored";
import type { DroppedFinding, Finding } from "../review/findings";
import { code, reviewLayout, sectionHeading } from "./review-layout";

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
  test("counts introduced high and medium findings as issues", () => {
    expect(layout([high, medium, low, nit]).headline).toEqual({
      icon: "🔴",
      text: "2 issues found",
    });
    expect(layout([medium]).headline.text).toBe("1 issue found");
  });

  test("is only nits when every introduced finding is low or a nit", () => {
    expect(layout([low]).headline).toEqual({
      icon: "🟡",
      text: "Only nits",
    });
    expect(layout([nit, old]).headline.text).toBe("Only nits");
  });

  test("flags a description mismatch over nits, but not over issues", () => {
    expect(layout([mismatch, nit]).headline).toEqual({
      icon: "🟡",
      text: "Description doesn't match the diff",
    });
    expect(layout([mismatch, high]).headline.text).toBe("1 issue found");
  });

  test("is all good when nothing was introduced, whatever was already wrong", () => {
    expect(layout([]).headline).toEqual({
      icon: "✅",
      text: "All good",
    });
    expect(layout([old]).headline.text).toBe("All good");
  });
});

describe("reviewLayout sections", () => {
  test("come in a fixed order, and only Issues and mismatches start open", () => {
    const { sections } = layout([nit, old, mismatch, high], {
      dropped: [
        {
          finding: low,
          reason: "Guarded.",
        },
      ],
    });
    expect(
      sections.map((s) => {
        return [sectionHeading(s), s.open];
      }),
    ).toEqual([
      ["Issues (1)", true],
      ["Description doesn't match the diff (1)", true],
      ["Nits (1)", false],
      ["Outside this PR's scope (1)", false],
      ["Dropped by verification (1)", false],
      ["What we looked at", false],
    ]);
  });

  test("leave out every empty section but What we looked at", () => {
    expect(titles([])).toEqual(["What we looked at"]);
    expect(titles([low, nit])).toEqual(["Nits (2)", "What we looked at"]);
    expect(titles([old])).toEqual([
      "Outside this PR's scope (1)",
      "What we looked at",
    ]);
  });

  test("list issues most severe first in a table", () => {
    expect(section("Issues", [medium, high])?.body).toBe(
      [
        "| Severity | Location | Issue |",
        "| --- | --- | --- |",
        "| **High** | `src/a.ts:10-12` | **Crashes on an empty list**<br>`items[0].id` throws when `items` is [].<br>See src/a.ts:11. |",
        "| **Medium** | `src/a.ts:10-12` | **Loses the last page**<br>`items[0].id` throws when `items` is [].<br>See src/a.ts:11. |",
      ].join("\n"),
    );
  });

  test("put low findings and nits under Nits", () => {
    expect(section("Nits", [nit, low])?.body).toBe(
      [
        "| Severity | Location | Issue |",
        "| --- | --- | --- |",
        "| **Low** | `src/b.ts:3` | **Off-by-one in the page count**<br>With 10 items and a page size of 5, it reports 3 pages. |",
        "| **Nit** | `src/b.ts:3` | **`n` could be `pageCount`**<br>The name says what it counts. |",
      ].join("\n"),
    );
  });

  test("escape pipes so a cell can't split the table", () => {
    const piped = {
      ...nit,
      title: "a || b",
      explanation: "x | y",
    };
    expect(section("Nits", [piped])?.body).toEndWith(
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
        "| 2 | **Low** | `src/b.ts:3` | Off-by-one in the page count |",
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

  test("list description mismatches apart from the code's issues", () => {
    expect(section("Issues", [mismatch])).toBeUndefined();
    expect(
      section("Description doesn't match the diff", [mismatch])?.body,
    ).toBe(
      [
        "| Severity | Location | Issue |",
        "| --- | --- | --- |",
        '| **Medium** | `src/a.ts:10-12` | **Says retries were added, but none were**<br>The description says "retries failed uploads", but `upload` still calls `fetch` once. |',
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
        "| **Low** | `src/b.ts:3` | **Off-by-one in the page count**<br>With 10 items and a page size of 5, it reports 3 pages. | No verdict returned |",
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
