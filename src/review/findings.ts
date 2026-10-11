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
  verdict: z.enum(["confirmed", "refuted"]),
  reason: z.string(),
});

export type Verdict = z.infer<typeof verdictSchema>;

export const verdictsSchema = z.object({
  verdicts: z.array(verdictSchema),
});

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

// A finding needs a confirmation and no refutation, so a skipped or
// contradictory verdict drops it.
export function splitByVerdict(findings: Finding[], verdicts: Verdict[]) {
  const confirmed: Finding[] = [];
  const dropped: DroppedFinding[] = [];
  findings.forEach((finding, index) => {
    const own = verdicts.filter((v) => {
      return v.id === index + 1;
    });
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
