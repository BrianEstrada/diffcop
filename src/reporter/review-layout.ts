import type { Explored, Search } from "@/agent/explored";
import { SEVERITIES } from "@/review/findings";
import type {
  DroppedFinding,
  Finding,
  ReviewResult,
  Severity,
} from "@/review/findings";

const SEVERITY_LABELS: Record<Severity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  nit: "Nit",
};

const MAX_LISTED = 30;

export interface Headline {
  icon: string;
  text: string;
}

export interface ReviewSection {
  title: string;
  count?: number;
  // Markdown, rendered as is by both the console and the PR comment.
  body: string;
  open: boolean;
}

export interface ReviewLayout {
  headline: Headline;
  sections: ReviewSection[];
}

function lines({ file, startLine, endLine }: Finding) {
  if (endLine <= startLine) {
    return `${file}:${startLine}`;
  }
  return `${file}:${startLine}-${endLine}`;
}

export interface LayoutOptions {
  // GitHub renders <br> inside a table cell; the terminal renderer prints it
  // literally and wraps long cells, so it gets a narrower table.
  html?: boolean;
}

function cell(text: string, html: boolean) {
  return text
    .trim()
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/g, html ? "<br>" : " ");
}

function bySeverity(a: Finding, b: Finding) {
  return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
}

function table(header: string[], rows: string[][]) {
  return [
    header,
    header.map(() => {
      return "---";
    }),
    ...rows,
  ]
    .map((row) => {
      return `| ${row.join(" | ")} |`;
    })
    .join("\n");
}

interface Row {
  finding: Finding;
  // The verifier's reason, for dropped findings.
  reason?: string;
}

function severityCell({ severity }: Finding) {
  return `**${SEVERITY_LABELS[severity]}**`;
}

function htmlTable(rows: Row[]) {
  const withReason = rows.some(({ reason }) => {
    return reason !== undefined;
  });
  const header = ["Severity", "Location", "Issue"];
  if (withReason) {
    header.push("Verifier");
  }
  return table(
    header,
    rows.map(({ finding, reason }) => {
      const row = [
        severityCell(finding),
        cell(code(lines(finding)), true),
        `**${cell(finding.title, true)}**<br>${cell(finding.explanation, true)}`,
      ];
      if (reason !== undefined) {
        row.push(cell(reason, true));
      }
      return row;
    }),
  );
}

// A terminal table wraps long cells into tall columns, so it keeps the short
// fields and the explanations follow as a list keyed by row number.
function terminalTable(rows: Row[]) {
  const summary = table(
    ["#", "Severity", "Location", "Title"],
    rows.map(({ finding }, index) => {
      return [
        String(index + 1),
        severityCell(finding),
        cell(code(lines(finding)), false),
        cell(finding.title, false),
      ];
    }),
  );
  const details = rows.map(({ finding, reason }, index) => {
    const paragraphs = [finding.explanation.trim()];
    if (reason !== undefined) {
      paragraphs.push(`Verifier: ${reason.trim()}`);
    }
    // Indented to the list marker so each paragraph stays in the item.
    return `${index + 1}. ${paragraphs.join("\n\n").replaceAll(/\n(?=.)/g, "\n   ")}`;
  });
  return `${summary}\n\n${details.join("\n")}`;
}

function rowsBody(rows: Row[], html: boolean) {
  const sorted = rows.toSorted((a, b) => {
    return bySeverity(a.finding, b.finding);
  });
  if (html) {
    return htmlTable(sorted);
  }
  return terminalTable(sorted);
}

function findingsTable(findings: Finding[], html: boolean) {
  return rowsBody(
    findings.map((finding) => {
      return { finding: finding };
    }),
    html,
  );
}

function droppedTable(dropped: DroppedFinding[], html: boolean) {
  return rowsBody(dropped, html);
}

// Patterns can contain backticks, so fence with a longer run than the text has.
export function code(text: string) {
  const runs = text.match(/`+/g) ?? [];
  if (runs.length === 0) {
    return `\`${text}\``;
  }
  const fence = "`".repeat(
    Math.max(
      ...runs.map((run) => {
        return run.length;
      }),
    ) + 1,
  );
  return `${fence} ${text} ${fence}`;
}

function capped(items: string[]) {
  const shown = items.slice(0, MAX_LISTED).join(", ");
  if (items.length <= MAX_LISTED) {
    return shown;
  }
  return `${shown} and ${items.length - MAX_LISTED} more`;
}

function search({ pattern, path }: Search) {
  if (path === undefined) {
    return code(pattern);
  }
  return `${code(pattern)} in ${code(path)}`;
}

function exploredBody(summary: string, { filesRead, searches }: Explored) {
  const paragraphs: string[] = [];
  if (summary.trim()) {
    paragraphs.push(summary.trim());
  }
  if (filesRead.length > 0) {
    paragraphs.push(
      `Read (${filesRead.length}): ${capped(filesRead.map(code))}`,
    );
  }
  if (searches.length > 0) {
    paragraphs.push(
      `Searched (${searches.length}): ${capped(searches.map(search))}`,
    );
  }
  return paragraphs.join("\n\n") || "Nothing recorded.";
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isIssue({ severity }: Finding) {
  return severity === "high" || severity === "medium";
}

type FindingGroup = "issues" | "mismatches" | "nits" | "preexisting";

function findingGroup(finding: Finding): FindingGroup {
  switch (finding.scope) {
    case "description":
      return "mismatches";
    case "preexisting":
      return "preexisting";
    case "introduced":
      if (isIssue(finding)) {
        return "issues";
      }
      return "nits";
  }
}

interface GroupLayout {
  group: FindingGroup;
  title: string;
  open: boolean;
  // Shown above the group's table.
  note?: string;
  headline?: (count: number) => Headline;
}

// In section order, which is also the headline's priority: the first group
// with findings and a headline sets it. Preexisting bugs don't block the PR.
const GROUP_LAYOUTS: GroupLayout[] = [
  {
    group: "issues",
    title: "Issues",
    open: true,
    headline: (count) => {
      return {
        icon: "🔴",
        text: `${plural(count, "issue")} found`,
      };
    },
  },
  {
    group: "mismatches",
    title: "Description doesn't match the diff",
    open: true,
    headline: () => {
      return {
        icon: "🟡",
        text: "Description doesn't match the diff",
      };
    },
  },
  {
    group: "nits",
    title: "Nits",
    open: false,
    headline: () => {
      return {
        icon: "🟡",
        text: "Only nits",
      };
    },
  },
  {
    group: "preexisting",
    title: "Outside this PR's scope",
    open: false,
    note: "Already wrong before this change, so not blocking it.",
  },
];

interface GroupedFindings {
  layout: GroupLayout;
  findings: Finding[];
}

function groupSection({ layout, findings }: GroupedFindings, html: boolean) {
  let body = findingsTable(findings, html);
  if (layout.note) {
    body = `${layout.note}\n\n${body}`;
  }
  return {
    title: layout.title,
    count: findings.length,
    body: body,
    open: layout.open,
  };
}

function headline(groups: GroupedFindings[]): Headline {
  for (const { layout, findings } of groups) {
    if (layout.headline) {
      return layout.headline(findings.length);
    }
  }
  return {
    icon: "✅",
    text: "All good",
  };
}

export function sectionHeading({ title, count }: ReviewSection) {
  if (count === undefined) {
    return title;
  }
  return `${title} (${count})`;
}

export function reviewLayout(
  {
    summary,
    findings,
    dropped,
    explored,
  }: Pick<ReviewResult, "summary" | "findings" | "dropped" | "explored">,
  { html = true }: LayoutOptions = {},
): ReviewLayout {
  const groups = GROUP_LAYOUTS.map((layout) => {
    return {
      layout: layout,
      findings: findings.filter((f) => {
        return findingGroup(f) === layout.group;
      }),
    };
  }).filter((group) => {
    return group.findings.length > 0;
  });
  const sections: ReviewSection[] = groups.map((group) => {
    return groupSection(group, html);
  });
  if (dropped.length > 0) {
    sections.push({
      title: "Dropped by verification",
      count: dropped.length,
      body: droppedTable(dropped, html),
      open: false,
    });
  }
  sections.push({
    title: "What we looked at",
    body: exploredBody(summary, explored),
    open: false,
  });
  return {
    headline: headline(groups),
    sections: sections,
  };
}
