import {
  addRound,
  appendRound,
  fitLedger,
  reviewLedgerSchema,
} from "@/review/review-ledger";
import type { ReviewLedger } from "@/review/review-ledger";
import type { LastReview } from "@/review/outstanding-work";
import { readSavedReview } from "@/reporter/github/saved-review-marker";
import { trailingMarker } from "@/reporter/github/trailing-marker";

// A comment keeps its round in its saved review. The ledger marker holds the round instead when the
// saved review is too long to keep, and every round so far in a comment from when diffcop kept only one.
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
      // Checked like a stored ledger: a round's commit is passed to git, so it has to be a SHA.
      ledger =
        reviewLedgerSchema.safeParse(
          appendRound(ledger, saved.headSha, saved.result),
        ).data ?? ledger;
    }
  }
  return ledger;
}

// The finished review a comment holds, if it holds one. A review too long to save
// still names its commit in the round it left.
export function lastReview(body: string | undefined): LastReview | undefined {
  if (body === undefined) {
    return undefined;
  }
  const saved = readSavedReview(body);
  if (saved) {
    return {
      headSha: saved.headSha,
      baseRef: saved.baseRef,
    };
  }
  const round = readLedger(body)?.rounds.at(-1);
  return round && { headSha: round.headSha };
}

export function holdsReview(body: string) {
  return readLedger(body) !== undefined || readSavedReview(body) !== undefined;
}

// Undefined for a comment without one.
export function readLedger(body: string): ReviewLedger | undefined {
  const encoded = trailingMarker(body, "ledger");
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
