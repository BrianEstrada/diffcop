import {
  addRound,
  appendRound,
  fitLedger,
  reviewLedgerSchema,
} from "@/review/review-ledger";
import type { ReviewLedger } from "@/review/review-ledger";
import { readSavedReview } from "@/reporter/github/saved-review-marker";

// A comment keeps its round in its saved review. This marker holds the round instead when the saved
// review is too long to keep, and every round so far in a comment from when diffcop kept only one.
const LEDGER = /<!-- diffcop:ledger=([A-Za-z0-9+/=]+) -->/g;

// Secrets are matched as JSON escapes them, so one with a quote or backslash is still caught.
function encode(ledger: ReviewLedger, secrets: string[]) {
  let json = JSON.stringify(ledger);
  for (const secret of secrets) {
    json = json.replaceAll(JSON.stringify(secret).slice(1, -1), "***");
  }
  const packed = Buffer.from(Bun.gzipSync(Buffer.from(json)));
  return `<!-- diffcop:ledger=${packed.toString("base64")} -->`;
}

// Trimmed until it fits in `maxChars`. Undefined when no round is left to keep.
export function ledgerMarker(
  ledger: ReviewLedger,
  secrets: string[],
  maxChars: number,
) {
  const fitted = fitLedger(ledger, (candidate) => {
    return encode(candidate, secrets).length <= maxChars;
  });
  if (fitted.rounds.length === 0) {
    return undefined;
  }
  return encode(fitted, secrets);
}

// What diffcop's comments on a PR remember, given oldest first: each one's round, and a later
// comment's round of a commit in place of an earlier one's.
export function ledgerFromComments(bodies: string[]) {
  let ledger: ReviewLedger | undefined;
  for (const body of bodies) {
    const kept = readLedger(body);
    const saved = readSavedReview(body);
    for (const round of kept?.rounds ?? []) {
      ledger = addRound(ledger, round);
    }
    if (!kept && saved) {
      ledger = appendRound(ledger, saved.headSha, saved.result);
    }
  }
  return ledger;
}

export function holdsReview(body: string) {
  return readLedger(body) !== undefined || readSavedReview(body) !== undefined;
}

// Undefined for a comment without one.
export function readLedger(body: string): ReviewLedger | undefined {
  // The last one: the marker follows the visible review, where a finding's text can quote one.
  const encoded = [...body.matchAll(LEDGER)].at(-1)?.[1];
  if (!encoded) {
    return undefined;
  }
  let decoded: unknown;
  try {
    const json = Bun.gunzipSync(Buffer.from(encoded, "base64"));
    decoded = JSON.parse(Buffer.from(json).toString());
  } catch {
    return undefined;
  }
  return reviewLedgerSchema.safeParse(decoded).data;
}
