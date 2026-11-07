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
  verdict: z.enum(["confirmed", "refuted", "duplicate"]),
  duplicateOf: z
    .int()
    .optional()
    .describe("With verdict duplicate: the id of the finding it repeats"),
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

// Ids are 1-based, as numberFindings gives them. A finding stays when it's
// named the duplicate of a missing finding, of itself or of one already gone.
export function removeDuplicates(findings: Finding[], duplicates: Duplicate[]) {
  const removed = new Set<number>();
  for (const { id, duplicateOf } of duplicates) {
    const valid =
      id !== duplicateOf &&
      [id, duplicateOf].every((n) => {
        return n >= 1 && n <= findings.length;
      });
    if (valid && !removed.has(duplicateOf)) {
      removed.add(id);
    }
  }
  return findings.filter((_, index) => {
    return !removed.has(index + 1);
  });
}

export interface DroppedFinding {
  finding: Finding;
  // Why the verifier didn't confirm it.
  reason: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  dropped: DroppedFinding[];
  explored: Explored;
  stats: RunStats;
}

// Ids are 1-based positions, the numbering the verifier is shown.
export function numberFindings(findings: Finding[]) {
  return findings.map((finding, index) => {
    return {
      id: index + 1,
      ...finding,
    };
  });
}

function isConfirmed(verdict: Verdict) {
  return verdict.verdict === "confirmed";
}

function dropReason(verdicts: Verdict[]) {
  if (verdicts.length === 0) {
    return "No verdict returned";
  }
  const reasons = verdicts
    .map((v) => {
      return v.reason.trim();
    })
    .filter(Boolean)
    .join(" / ");
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
// contradictory verdict drops it. A duplicate is left out of both lists, its
// original standing for it, unless that original is itself marked a duplicate.
export function splitByVerdict(findings: Finding[], verdicts: Verdict[]) {
  const confirmed: Finding[] = [];
  const dropped: DroppedFinding[] = [];
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
      confirmed.push(finding);
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
  };
}
