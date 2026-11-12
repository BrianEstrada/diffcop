import { savedReviewSchema } from "@/review/saved-review";
import type { SavedReview } from "@/review/saved-review";

// Base64, since a finding's text could hold `-->` and end the HTML comment early.
const SAVED_REVIEW = /<!-- diffcop:saved=([A-Za-z0-9+/=]+) -->/g;

// Gzipped, so a long review still fits in its comment.
// Secrets are matched as JSON escapes them, so one with a quote or backslash is still caught.
export function savedReviewMarker(saved: SavedReview, secrets: string[]) {
  let json = JSON.stringify(saved);
  for (const secret of secrets) {
    json = json.replaceAll(JSON.stringify(secret).slice(1, -1), "***");
  }
  const packed = Buffer.from(Bun.gzipSync(Buffer.from(json)));
  return `<!-- diffcop:saved=${packed.toString("base64")} -->`;
}

// Markers written before they were gzipped are plain JSON.
function unpack(encoded: string) {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return Buffer.from(Bun.gunzipSync(bytes)).toString();
  }
  return bytes.toString();
}

// Undefined for a comment without one: a failed review, one too long to keep it, or older than this format.
export function readSavedReview(body: string): SavedReview | undefined {
  // The last one: the marker follows the visible review, where a finding's text can quote one.
  const encoded = [...body.matchAll(SAVED_REVIEW)].at(-1)?.[1];
  if (!encoded) {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(unpack(encoded));
  } catch {
    return undefined;
  }
  return savedReviewSchema.safeParse(decoded).data;
}
