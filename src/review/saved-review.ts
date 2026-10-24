import { z } from "zod";
import type { Explored } from "@/agent/explored";
import type { RunStats } from "@/agent/reviewer-agent";
import { findingSchema } from "@/review/findings";
import type { DroppedFinding, Finding, ReviewResult } from "@/review/findings";

const exploredSchema = z.object({
  filesRead: z.array(z.string()),
  searches: z.array(
    z.object({
      pattern: z.string(),
      path: z.string().optional(),
    }),
  ),
}) satisfies z.ZodType<Explored>;

const runStatsSchema = z.object({
  durationMs: z.number(),
  toolCalls: z.number(),
  inputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
}) satisfies z.ZodType<RunStats>;

const reviewResultSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
  dropped: z.array(
    z.object({
      finding: findingSchema,
      reason: z.string(),
    }),
  ),
  explored: exploredSchema,
  stats: runStatsSchema,
}) satisfies z.ZodType<ReviewResult>;

// What a later run needs to re-check the description without reviewing the code again.
export const savedReviewSchema = z.object({
  version: z.literal(1),
  headSha: z.string(),
  // The event time of the description the findings were checked against.
  descriptionAt: z.string().optional(),
  warnings: z.array(z.string()),
  result: reviewResultSchema,
});

export type SavedReview = z.infer<typeof savedReviewSchema>;

export function isDescriptionFinding({ scope }: Finding) {
  return scope === "description";
}

// Swaps the description findings for a re-check's, leaving the code findings as reviewed.
export function withDescriptionFindings(
  saved: SavedReview,
  {
    findings,
    dropped,
    explored,
    descriptionAt,
  }: {
    findings: Finding[];
    dropped: DroppedFinding[];
    explored: Explored;
    descriptionAt: string | undefined;
  },
): SavedReview {
  const { result } = saved;
  return {
    ...saved,
    descriptionAt: descriptionAt,
    result: {
      ...result,
      findings: [
        ...result.findings.filter((finding) => {
          return !isDescriptionFinding(finding);
        }),
        ...findings,
      ],
      dropped: [
        ...result.dropped.filter(({ finding }) => {
          return !isDescriptionFinding(finding);
        }),
        ...dropped,
      ],
      explored: explored,
    },
  };
}
