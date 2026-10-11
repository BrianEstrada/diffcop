import { z } from "zod";

// Octokit's response types are compile-time only, so callers safeParse what
// GitHub sent; this says which response didn't match.
export function unwrapResponse<T>(
  result: z.ZodSafeParseResult<T>,
  source: string,
): T {
  if (!result.success) {
    throw new Error(
      `Unexpected response from ${source}:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
