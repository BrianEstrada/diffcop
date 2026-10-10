import { z } from "zod";

// Octokit's response types are compile-time only, so check what GitHub sent.
export function parseResponse<T extends z.ZodType>(
  schema: T,
  data: unknown,
  source: string,
): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `Unexpected response from ${source}:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
