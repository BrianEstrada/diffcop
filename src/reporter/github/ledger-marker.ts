import { fitLedger, reviewLedgerSchema } from "@/review/review-ledger";
import type { ReviewLedger } from "@/review/review-ledger";

// Gzipped, then base64: a ledger of several rounds would otherwise outgrow the comment.
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

// Undefined for a comment without one, such as a PR's first review or a comment from before ledgers.
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
