import { savedReviewSchema } from "@/review/saved-review";
import type { SavedReview } from "@/review/saved-review";

// Base64, since a finding's text could hold `-->` and end the HTML comment early.
const SAVED_REVIEW = /<!-- diffcop:saved=([A-Za-z0-9+/=]+) -->/;

// Secrets are matched as JSON escapes them, so one with a quote or backslash is still caught.
export function savedReviewMarker(saved: SavedReview, secrets: string[]) {
  let json = JSON.stringify(saved);
  for (const secret of secrets) {
    json = json.replaceAll(JSON.stringify(secret).slice(1, -1), "***");
  }
  return `<!-- diffcop:saved=${Buffer.from(json).toString("base64")} -->`;
}

// Undefined for a comment without one: running, failed, cancelled, too long to keep it, or older than this format.
export function readSavedReview(body: string): SavedReview | undefined {
  const encoded = body.match(SAVED_REVIEW)?.[1];
  if (!encoded) {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64").toString());
  } catch {
    return undefined;
  }
  return savedReviewSchema.safeParse(decoded).data;
}
