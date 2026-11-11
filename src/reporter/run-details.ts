import type { RunStats } from "@/agent/reviewer-agent";
import { CHUNK_PASSES } from "@/prompt/review-prompt-builder";
import type { ReviewSection } from "@/reporter/review-layout";
import {
  formatCached,
  formatCost,
  formatCount,
  formatDuration,
} from "@/reporter/stats";
import type { FinderSummary } from "@/review/saved-review";

const UNKNOWN = "–";

export interface RunDetails {
  stats: RunStats;
  // The run that re-checked only the description, after the review.
  recheck?: RunStats;
  // The parallel finders' runs, none when one finder reviewed the diff. Absent when unknown.
  finders?: FinderSummary[];
  merged?: number;
  // The last reviewed commit, when the split followed what changed since it.
  since?: string;
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

function known<T>(value: T | undefined, format: (value: T) => string) {
  return value === undefined ? UNKNOWN : format(value);
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function runRow(name: string, stats: RunStats) {
  return [
    name,
    formatDuration(stats.durationMs),
    String(stats.toolCalls),
    known(stats.inputTokens, formatCount),
    formatCached(stats) ?? UNKNOWN,
    known(stats.outputTokens, formatCount),
    known(stats.costUsd, formatCost),
  ];
}

function runsTable({ stats, recheck }: RunDetails) {
  const rows = [runRow("Review", stats)];
  if (recheck) {
    rows.push(runRow("Description re-check", recheck));
  }
  return table(
    ["Run", "Time", "Tool calls", "Input tokens", "Cached", "Output", "Cost"],
    rows,
  );
}

function finderName({ chunk }: FinderSummary, pass: number) {
  if (chunk === undefined) {
    return "Whole diff";
  }
  if (pass === 0) {
    return `Chunk ${chunk}`;
  }
  return `Chunk ${chunk}, pass ${pass + 1}`;
}

function errorCell(error = "") {
  return error.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

// A failed finder has no stats; its error stands in for them.
function finderRow(finder: FinderSummary, pass: number) {
  const { stats } = finder;
  return [
    finderName(finder, pass),
    known(finder.files, String),
    known(finder.lines, formatCount),
    String(finder.findings),
    known(stats?.durationMs, formatDuration),
    known(stats?.toolCalls, String),
    known(stats?.costUsd, formatCost),
    errorCell(finder.error),
  ];
}

// Each chunk's passes together, in chunk order, and the whole-diff finder last.
function findersTable(finders: FinderSummary[]) {
  const seen = new Map<number | undefined, number>();
  const rows = finders
    .map((finder) => {
      const pass = seen.get(finder.chunk) ?? 0;
      seen.set(finder.chunk, pass + 1);
      return {
        finder: finder,
        pass: pass,
      };
    })
    .toSorted((a, b) => {
      return (
        (a.finder.chunk ?? Infinity) - (b.finder.chunk ?? Infinity) ||
        a.pass - b.pass
      );
    })
    .map(({ finder, pass }) => {
      return finderRow(finder, pass);
    });
  const header = [
    "Finder",
    "Files",
    "Changed lines",
    "Findings",
    "Time",
    "Tool calls",
    "Cost",
    "Failed",
  ];
  const failed = header.length - 1;
  const anyFailed = rows.some((row) => {
    return row[failed] !== "";
  });
  const width = anyFailed ? header.length : failed;
  return table(
    header.slice(0, width),
    rows.map((row) => {
      return row.slice(0, width);
    }),
  );
}

function splitSummary({ finders = [], merged = 0, since }: RunDetails) {
  const chunks = new Set(
    finders.flatMap(({ chunk }) => {
      return chunk === undefined ? [] : [chunk];
    }),
  ).size;
  let what = "The diff";
  if (since !== undefined) {
    what = `What changed since \`${since.slice(0, 7)}\``;
  }
  const sentences = [
    `${what} was split into ${plural(chunks, "chunk")}, each reviewed by ${CHUNK_PASSES} finders, and one more finder reviewed the whole diff.`,
  ];
  if (merged > 0) {
    sentences.push(
      `${plural(merged, "duplicate finding")} ${merged === 1 ? "was" : "were"} merged before verification.`,
    );
  }
  return sentences.join(" ");
}

// The numbers the footer used to hold in one line, and how the review was split.
export function runDetailsSection(details: RunDetails): ReviewSection {
  const { finders } = details;
  const blocks = [runsTable(details)];
  if (finders && finders.length > 0) {
    blocks.push(splitSummary(details), findersTable(finders));
  } else if (finders) {
    blocks.push("One finder reviewed the whole diff.");
  }
  return {
    title: "Run details",
    body: blocks.join("\n\n"),
    open: false,
  };
}
