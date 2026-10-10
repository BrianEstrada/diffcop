import type { ReviewResult } from "../review/findings";

export interface TextSink {
  write(text: string): unknown;
}

// `started`, `warning`, `verifying` and `failed` must not throw: a report
// shouldn't stop the review or hide the error that ended it.
export interface ReviewReporter {
  started(): Promise<void>;
  // Async so the GitHub reporter can update its status comment before the
  // review starts.
  warning(message: string): Promise<void>;
  toolCall(toolName: string, input: unknown): void;
  thinking(durationMs: number): void;
  verifying(findings: number): Promise<void>;
  completed(result: ReviewResult): Promise<void>;
  failed(error: unknown, options: { cancelled: boolean }): Promise<void>;
}
