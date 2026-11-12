import { z } from "zod";
import { SCOPES, SEVERITIES } from "@/review/findings";
import type { Finding, ReviewResult } from "@/review/findings";

export const LEDGER_STATUSES = [
  "reported",
  "dropped",
  "settled",
  "fixed",
] as const;

export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

const ledgerEntrySchema = z.object({
  file: z.string(),
  startLine: z.int().positive(),
  endLine: z.int().positive(),
  severity: z.enum(SEVERITIES),
  scope: z.enum(SCOPES),
  title: z.string(),
  // Trimmed first when the ledger outgrows its store.
  explanation: z.string().optional(),
  status: z.enum(LEDGER_STATUSES),
  // The verifier's reason, for a dropped, settled or fixed finding.
  reason: z.string().optional(),
  // The author's reply, for a caller that has it; on a PR it's in the description instead.
  answer: z.string().optional(),
});

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

const ledgerRoundSchema = z.object({
  // Hex only: it's passed to git as an argument.
  headSha: z.string().regex(/^[0-9a-f]{7,64}$/),
  entries: z.array(ledgerEntrySchema),
  // Its reported entries are every finding still open then, not only what the round found anew.
  // Absent from a round reviewed before open findings were all carried over.
  complete: z.boolean().optional(),
});

export type LedgerRound = z.infer<typeof ledgerRoundSchema>;

// What earlier reviews of the same change found, oldest round first.
export const reviewLedgerSchema = z.object({
  version: z.literal(1),
  rounds: z.array(ledgerRoundSchema),
});

export type ReviewLedger = z.infer<typeof reviewLedgerSchema>;

export function isMajor({ severity }: Pick<Finding, "severity">) {
  return severity === "high" || severity === "medium";
}

function entry(
  finding: Finding,
  status: LedgerStatus,
  reason?: string,
): LedgerEntry {
  return {
    ...finding,
    status: status,
    ...(reason !== undefined && { reason: reason }),
  };
}

// The description is checked afresh against its current text every round, so its findings aren't kept.
function isCodeFinding({ scope }: Finding) {
  return scope !== "description";
}

// Reviewing a commit again redoes its round rather than adding one.
export function earlierRounds(
  ledger: ReviewLedger | undefined,
  headSha: string,
) {
  return (ledger?.rounds ?? []).filter((round) => {
    return round.headSha !== headSha;
  });
}

export function appendRound(
  ledger: ReviewLedger | undefined,
  headSha: string,
  { findings, dropped, rereview }: ReviewResult,
): ReviewLedger {
  const entries = [
    ...findings.filter(isCodeFinding).map((finding) => {
      return entry(finding, "reported");
    }),
    ...dropped
      .filter(({ finding }) => {
        return isCodeFinding(finding);
      })
      .map(({ finding, reason }) => {
        return entry(finding, "dropped", reason);
      }),
    ...(rereview?.settled ?? []).map(({ finding, reason }) => {
      return entry(finding, "settled", reason);
    }),
    ...(rereview?.fixed ?? []).map(({ finding, reason }) => {
      return entry(finding, "fixed", reason);
    }),
  ];
  return addRound(ledger, {
    headSha: headSha,
    entries: entries,
    // A first review lists all it found. A later one does once it carries the open ones over.
    ...((!rereview || rereview.fixed !== undefined) && { complete: true }),
  });
}

// Last in the ledger, in place of any round the commit already had.
export function addRound(
  ledger: ReviewLedger | undefined,
  round: LedgerRound,
): ReviewLedger {
  return {
    version: 1,
    rounds: [...earlierRounds(ledger, round.headSha), round],
  };
}

function isOpen({ status }: LedgerEntry) {
  return status === "reported";
}

// Across rounds, where a finding's lines move with the code around it.
function sameFinding(a: LedgerEntry, b: LedgerEntry) {
  return a.file === b.file && a.title === b.title;
}

// Every finding still open after the last round, each checked again this round: one that's
// still there stays in the review, and one that's gone is reported as fixed.
// A round from before open findings were all carried over repeated only the bugs, so its minor
// ones are still in the rounds that first reported them, unless a later round judged them.
export function carriedFindings(rounds: LedgerRound[]): Finding[] {
  const open: LedgerEntry[] = [];
  const later: LedgerEntry[] = [];
  for (const [age, round] of rounds.toReversed().entries()) {
    open.push(
      ...round.entries.filter((item) => {
        return (
          isOpen(item) &&
          (age === 0 || !isMajor(item)) &&
          !later.some((judged) => {
            return sameFinding(judged, item);
          })
        );
      }),
    );
    later.push(...round.entries);
    if (round.complete) {
      break;
    }
  }
  return open.map(
    ({ status: _status, reason: _reason, answer: _answer, ...item }) => {
      return {
        ...item,
        explanation: item.explanation ?? "",
      };
    },
  );
}

function mapRound(
  ledger: ReviewLedger,
  index: number,
  update: (entries: LedgerEntry[]) => LedgerEntry[],
): ReviewLedger {
  return {
    ...ledger,
    rounds: ledger.rounds.map((round, at) => {
      if (at !== index) {
        return round;
      }
      return {
        ...round,
        entries: update(round.entries),
      };
    }),
  };
}

function withoutExplanations(entries: LedgerEntry[]) {
  return entries.map(({ explanation: _explanation, ...item }) => {
    return item;
  });
}

// Dropped and settled entries are what stop a finding coming back, so they outlast the reported ones.
function withoutReported(entries: LedgerEntry[]) {
  return entries.filter((item) => {
    return item.status !== "reported";
  });
}

// Trims until `fits`, oldest round first at each step: explanations, then reported
// entries of every round but the last, then whole rounds.
export function fitLedger(
  ledger: ReviewLedger,
  fits: (ledger: ReviewLedger) => boolean,
): ReviewLedger {
  let fitted = ledger;
  const last = ledger.rounds.length - 1;
  const steps = [
    ...ledger.rounds.map((_, index) => {
      return (current: ReviewLedger) => {
        return mapRound(current, index, withoutExplanations);
      };
    }),
    ...ledger.rounds.slice(0, Math.max(0, last)).map((_, index) => {
      return (current: ReviewLedger) => {
        return mapRound(current, index, withoutReported);
      };
    }),
    ...ledger.rounds.map(() => {
      return (current: ReviewLedger) => {
        return {
          ...current,
          rounds: current.rounds.slice(1),
        };
      };
    }),
  ];
  for (const step of steps) {
    if (fits(fitted)) {
      return fitted;
    }
    fitted = step(fitted);
  }
  return fitted;
}
