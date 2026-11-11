import { z } from "zod";
import type { Explored } from "@/agent/explored";
import type { RunStats } from "@/agent/reviewer-agent";

export const SEVERITIES = ["high", "medium", "low", "nit"] as const;

export type Severity = (typeof SEVERITIES)[number];

export const SCOPES = ["introduced", "preexisting", "description"] as const;

export type Scope = (typeof SCOPES)[number];

// Descriptions end up in the JSON schema the model answers to.
export const findingSchema = z.object({
  file: z.string().describe("Path relative to the repository root"),
  startLine: z.int().positive(),
  endLine: z.int().positive(),
  severity: z
    .enum(SEVERITIES)
    .describe(
      "high, medium or low: a bug, by impact. nit: not a bug, but readability, clarity, naming or a small cleanup on a changed line; never anything a formatter or linter enforces",
    ),
  scope: z
    .enum(SCOPES)
    .describe(
      "introduced: this diff caused it. preexisting: it was already wrong before this diff. description: the PR description claims something the diff doesn't do",
    ),
  title: z.string().describe("One-line summary of the bug or nit"),
  explanation: z
    .string()
    .describe(
      "At most two sentences: which input or state fails and why, citing the code. For a nit, what to change and why",
    ),
});

export type Finding = z.infer<typeof findingSchema>;

export const findingsSchema = z.object({
  summary: z
    .string()
    .describe(
      "One sentence on what you checked, e.g. the call paths you traced",
    ),
  findings: z.array(findingSchema),
});

const verdictSchema = z.object({
  id: z.int().describe("The finding's id"),
  verdict: z
    .enum(["confirmed", "refuted", "duplicate", "settled"])
    .describe(
      "settled: only when the instructions describe it, for a finding an earlier round already dealt with",
    ),
  duplicateOf: z
    .int()
    .optional()
    .describe("With verdict duplicate: the id of the finding it repeats"),
  startLine: z
    .int()
    .positive()
    .optional()
    .describe(
      "Only for a confirmed finding marked earlierRound whose lines have moved: where the defect starts now",
    ),
  endLine: z
    .int()
    .positive()
    .optional()
    .describe("With startLine: where the defect ends now"),
  reason: z.string(),
});

export type Verdict = z.infer<typeof verdictSchema>;

export const verdictsSchema = z.object({
  verdicts: z.array(verdictSchema),
});

const duplicateSchema = z.object({
  id: z.int().describe("The id of the finding that repeats another"),
  duplicateOf: z.int().describe("The id of the finding it repeats"),
});

export type Duplicate = z.infer<typeof duplicateSchema>;

export const duplicatesSchema = z.object({
  duplicates: z.array(duplicateSchema),
});

export interface MergedFinding {
  finding: Finding;
  // The finding kept in its place.
  into: Finding;
}

// Ids are 1-based. A pair is skipped when its target is missing, itself or already
// gone, or when a finding was already merged into it, so merges never chain.
export function removeDuplicates(findings: Finding[], duplicates: Duplicate[]) {
  const into = new Map<number, number>();
  for (const { id, duplicateOf } of duplicates) {
    const valid =
      id !== duplicateOf &&
      [id, duplicateOf].every((n) => {
        return n >= 1 && n <= findings.length;
      });
    const isTarget = [...into.values()].includes(id);
    if (valid && !into.has(duplicateOf) && !isTarget) {
      into.set(id, duplicateOf);
    }
  }
  const kept: Finding[] = [];
  const merged: MergedFinding[] = [];
  findings.forEach((finding, index) => {
    const target = findings[(into.get(index + 1) ?? 0) - 1];
    if (target) {
      merged.push({
        finding: finding,
        into: target,
      });
    } else {
      kept.push(finding);
    }
  });
  return {
    kept: kept,
    merged: merged,
  };
}

// A finding from an earlier round has that round's line numbers, so when a
// finder found the same defect afresh, the fresh one is the one to keep.
export function preferFresh(
  { kept, merged }: { kept: Finding[]; merged: MergedFinding[] },
  carried: ReadonlySet<Finding>,
) {
  const fresh = new Map<Finding, Finding>();
  for (const { finding, into } of merged) {
    if (carried.has(into) && !carried.has(finding) && !fresh.has(into)) {
      fresh.set(into, finding);
    }
  }
  return {
    kept: kept.map((finding) => {
      return fresh.get(finding) ?? finding;
    }),
    merged: merged.map(({ finding, into }) => {
      const replacement = fresh.get(into);
      if (replacement === finding) {
        return {
          finding: into,
          into: replacement,
        };
      }
      return {
        finding: finding,
        into: replacement ?? into,
      };
    }),
  };
}

export interface DroppedFinding {
  finding: Finding;
  // Why the verifier didn't confirm it.
  reason: string;
}

export interface SettledFinding {
  finding: Finding;
  // Which earlier finding or answer settles it.
  reason: string;
}

// How earlier rounds shaped a re-review.
export interface Rereview {
  // The last reviewed commit, when minor findings were kept to what changed since it.
  since?: string;
  settled: SettledFinding[];
  // Minor findings left out for citing code unchanged since `since`.
  leftOut: number;
}

// One parallel finder's share of a chunked review, for tuning the split.
export interface FinderRun {
  // Absent for the whole-diff finder.
  files?: string[];
  // Which chunk the files are, from 1, and the changed lines it was sized by.
  chunk?: number;
  lines?: number;
  findings: number;
  // Absent when the finder failed; `error` says why.
  stats?: RunStats;
  error?: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  dropped: DroppedFinding[];
  explored: Explored;
  stats: RunStats;
  // Only when parallel finders ran.
  finders?: FinderRun[];
  merged?: MergedFinding[];
  // Only when earlier rounds of the same change were taken into account.
  rereview?: Rereview;
}

// Ids are 1-based positions, the numbering the verifier is shown. `carried` marks
// the findings an earlier round reported, whose lines are that round's.
export function numberFindings(
  findings: Finding[],
  carried: ReadonlySet<Finding> = new Set(),
) {
  return findings.map((finding, index) => {
    return {
      id: index + 1,
      ...finding,
      ...(carried.has(finding) && { earlierRound: true }),
    };
  });
}

function isConfirmed(verdict: Verdict) {
  return verdict.verdict === "confirmed";
}

function isSettled(verdict: Verdict) {
  return verdict.verdict === "settled";
}

// The verifier's lines for a finding whose code has moved, when it gave a valid range.
function relocated(finding: Finding, [verdict]: Verdict[]): Finding {
  const { startLine, endLine = startLine } = verdict ?? {};
  if (startLine === undefined || endLine === undefined || endLine < startLine) {
    return finding;
  }
  return {
    ...finding,
    startLine: startLine,
    endLine: endLine,
  };
}

function joinReasons(verdicts: Verdict[]) {
  return verdicts
    .map((v) => {
      return v.reason.trim();
    })
    .filter(Boolean)
    .join(" / ");
}

export const NO_VERDICT = "No verdict returned";

function dropReason(verdicts: Verdict[]) {
  if (verdicts.length === 0) {
    return NO_VERDICT;
  }
  const reasons = joinReasons(verdicts);
  if (verdicts.some(isConfirmed)) {
    return `Contradictory verdicts: ${reasons}`;
  }
  return reasons || "Refuted without a reason";
}

// The id of the other finding this one repeats, when every verdict on it says so.
function duplicateTarget(own: Verdict[], id: number, count: number) {
  const targets = new Set(
    own.map((v) => {
      return v.verdict === "duplicate" ? v.duplicateOf : undefined;
    }),
  );
  const [target] = targets;
  if (
    own.length === 0 ||
    targets.size !== 1 ||
    target === undefined ||
    target === id ||
    target < 1 ||
    target > count
  ) {
    return undefined;
  }
  return target;
}

// A finding needs a confirmation and no refutation, so a skipped or
// contradictory verdict drops it. A duplicate is left out of every list, its
// original standing for it, unless that original is itself marked a duplicate.
export function splitByVerdict(findings: Finding[], verdicts: Verdict[]) {
  const confirmed: Finding[] = [];
  const dropped: DroppedFinding[] = [];
  const settled: SettledFinding[] = [];
  const verdictsOf = findings.map((_, index) => {
    return verdicts.filter((v) => {
      return v.id === index + 1;
    });
  });
  const targets = verdictsOf.map((own, index) => {
    return duplicateTarget(own, index + 1, findings.length);
  });
  findings.forEach((finding, index) => {
    const own = verdictsOf[index] ?? [];
    const target = targets[index];
    if (target !== undefined) {
      if (targets[target - 1] !== undefined) {
        dropped.push({
          finding: finding,
          reason: "Marked a duplicate of another duplicate",
        });
      }
      return;
    }
    if (own.length > 0 && own.every(isConfirmed)) {
      confirmed.push(relocated(finding, own));
    } else if (own.length > 0 && own.every(isSettled)) {
      settled.push({
        finding: finding,
        reason: joinReasons(own) || "Settled in an earlier round",
      });
    } else {
      dropped.push({
        finding: finding,
        reason: dropReason(own),
      });
    }
  });
  return {
    confirmed: confirmed,
    dropped: dropped,
    settled: settled,
  };
}
