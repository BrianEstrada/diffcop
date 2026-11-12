import type { Explored, Search } from "@/agent/explored";
import { SEVERITIES } from "@/review/findings";
import type {
  DroppedFinding,
  Finding,
  Rereview,
  ReviewResult,
  Severity,
} from "@/review/findings";

// Low and nit read as one level: which of the two a finding got never told readers which mattered.
const SEVERITY_LABELS: Record<Severity, string> = {
  high: "High",
  medium: "Medium",
  low: "Minor",
  nit: "Minor",
};

const MAX_LISTED = 30;

export interface Headline {
  icon: string;
  text: string;
  // Whether the PR's status check should fail on it.
  blocking: boolean;
}

export interface ReviewSection {
  title: string;
  count?: number;
  // Markdown, rendered as is by both the console and the PR comment.
  body: string;
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

// A description finding blocks the PR whatever its severity, so it's named for what it is.
function severityCell({ severity, scope }: Finding) {
  if (scope === "description") {
    return "**Description**";
  }
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
  if (html) {
    return htmlTable(rows);
  }
  return terminalTable(rows);
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
  return rowsBody(
    dropped.toSorted((a, b) => {
      return bySeverity(a.finding, b.finding);
    }),
    html,
  );
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

function leftOutNote({ leftOut, since }: Rereview) {
  if (leftOut === 0 || since === undefined) {
    return undefined;
  }
  return `Left out ${plural(leftOut, "minor finding")} on code that hasn't changed since ${code(since.slice(0, 7))}, the last commit reviewed.`;
}

function exploredBody(
  summary: string,
  { filesRead, searches }: Explored,
  rereview: Rereview | undefined,
) {
  const paragraphs: string[] = [];
  if (summary.trim()) {
    paragraphs.push(summary.trim());
  }
  const leftOut = rereview && leftOutNote(rereview);
  if (leftOut) {
    paragraphs.push(leftOut);
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

type FindingGroup = "issues" | "mismatches" | "minor" | "preexisting";

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
      return "minor";
  }
}

function inGroup(findings: Finding[], group: FindingGroup) {
  return findings.filter((finding) => {
    return findingGroup(finding) === group;
  });
}

// Everything the headline counts, in the order it names them: bugs, then the description, then the rest.
function reported(findings: Finding[]) {
  return [
    ...inGroup(findings, "issues").toSorted(bySeverity),
    ...inGroup(findings, "mismatches").toSorted(bySeverity),
    ...inGroup(findings, "minor").toSorted(bySeverity),
  ];
}

function headlineIcon(blocking: number, total: number) {
  if (blocking > 0) {
    return "🔴";
  }
  if (total > 0) {
    return "🟡";
  }
  return "✅";
}

function capitalized(text: string) {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

// The comment's sections are all collapsed, so this line is the review at a glance: what was
// found and how much of it. Preexisting bugs don't block the PR and aren't counted.
export function reviewHeadline(findings: Finding[]): Headline {
  const issues = inGroup(findings, "issues").length;
  const mismatches = inGroup(findings, "mismatches").length;
  const minor = inGroup(findings, "minor").length;
  const parts: string[] = [];
  if (issues > 0) {
    parts.push(plural(issues, "issue"));
  }
  if (mismatches > 0) {
    parts.push("description doesn't match the diff");
  }
  if (minor > 0) {
    parts.push(plural(minor, "minor finding"));
  }
  let text = capitalized(parts.join(", ")) || "All good";
  if (parts.length === 1 && issues > 0) {
    text = `${text} found`;
  }
  return {
    icon: headlineIcon(issues, issues + mismatches + minor),
    text: text,
    blocking: issues + mismatches > 0,
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
    rereview,
  }: Pick<
    ReviewResult,
    "summary" | "findings" | "dropped" | "explored" | "rereview"
  >,
  { html = true }: LayoutOptions = {},
): ReviewLayout {
  const sections: ReviewSection[] = [];
  const counted = reported(findings);
  if (counted.length > 0) {
    sections.push({
      title: "Findings",
      count: counted.length,
      body: findingsTable(counted, html),
    });
  }
  const preexisting = inGroup(findings, "preexisting").toSorted(bySeverity);
  if (preexisting.length > 0) {
    sections.push({
      title: "Outside this PR's scope",
      count: preexisting.length,
      body: `Already wrong before this change, so not blocking it.\n\n${findingsTable(preexisting, html)}`,
    });
  }
  if (dropped.length > 0) {
    sections.push({
      title: "Dropped by verification",
      count: dropped.length,
      body: droppedTable(dropped, html),
    });
  }
  const settled = rereview?.settled ?? [];
  if (settled.length > 0) {
    sections.push({
      title: "Settled in an earlier round",
      count: settled.length,
      body: droppedTable(settled, html),
    });
  }
  sections.push({
    title: "What we looked at",
    body: exploredBody(summary, explored, rereview),
  });
  return {
    headline: reviewHeadline(findings),
    sections: sections,
  };
}
