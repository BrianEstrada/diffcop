import type { ReviewResult } from "@/review/findings";

export interface TextSink {
  write(text: string): void;
}

// `started`, `warning`, `verifying` and `failed` must not throw: a report
// shouldn't stop the review or hide the error that ended it.
export interface ReviewReporter {
  started(): Promise<void>;
  // Async so the GitHub reporter can update its status comment before the
  // review starts.
  warning(message: string): Promise<void>;
  toolCall(toolName: string, input: string): void;
  thinking(durationMs: number): void;
  verifying(findings: number): Promise<void>;
  completed(result: ReviewResult): Promise<void>;
  failed(error: Error, options: { cancelled: boolean }): Promise<void>;
}
