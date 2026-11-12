import { savedReviewSchema } from "@/review/saved-review";
import type { SavedReview } from "@/review/saved-review";
import { trailingMarker } from "@/reporter/github/trailing-marker";

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
  const encoded = trailingMarker(body, "saved");
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
