import { z } from "zod";
import type { Explored } from "@/agent/explored";
import type { RunStats } from "@/agent/reviewer-agent";
import { findingSchema } from "@/review/findings";
import type {
  DroppedFinding,
  Finding,
  FinderRun,
  ReviewResult,
} from "@/review/findings";

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

const judgedFindingSchema = z.object({
  finding: findingSchema,
  reason: z.string(),
});

const reviewResultSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
  dropped: z.array(judgedFindingSchema),
  explored: exploredSchema,
  stats: runStatsSchema,
  rereview: z
    .object({
      since: z.string().optional(),
      settled: z.array(judgedFindingSchema),
      fixed: z.array(judgedFindingSchema).optional(),
      stillOpen: z.number().optional(),
      leftOut: z.number(),
    })
    .optional(),
}) satisfies z.ZodType<ReviewResult>;

// A parallel finder's run without its file paths, which would bloat the saved review.
const finderSummarySchema = z.object({
  // Absent for the whole-diff finder.
  chunk: z.number().optional(),
  files: z.number().optional(),
  lines: z.number().optional(),
  findings: z.number(),
  stats: runStatsSchema.optional(),
  error: z.string().optional(),
});

export type FinderSummary = z.infer<typeof finderSummarySchema>;

const MAX_FINDER_ERROR_CHARS = 200;

// An install failure's message runs to many lines, which would crowd out the saved review itself.
function shortError(error: string) {
  const [firstLine = ""] = error.trim().split(/\r?\n/);
  return firstLine.slice(0, MAX_FINDER_ERROR_CHARS);
}

export function summarizeFinders(finders: FinderRun[]): FinderSummary[] {
  return finders.map(({ files, error, ...finder }) => {
    return {
      ...finder,
      ...(files && { files: files.length }),
      ...(error !== undefined && { error: shortError(error) }),
    };
  });
}

// What a later run needs to re-check the description without reviewing the code again.
export const savedReviewSchema = z.object({
  version: z.literal(1),
  headSha: z.string(),
  // The branch the review's diff was against. Absent from a review saved before this was kept.
  baseRef: z.string().optional(),
  // The event time of the description the findings were checked against.
  descriptionAt: z.string().optional(),
  warnings: z.array(z.string()),
  result: reviewResultSchema,
  // The parallel finders' runs, none when one finder reviewed the diff, and how many duplicate
  // findings were merged. Absent from a review saved before these were kept.
  finders: z.array(finderSummarySchema).optional(),
  merged: z.number().optional(),
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
