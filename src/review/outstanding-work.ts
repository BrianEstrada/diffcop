// The last review that finished, as diffcop's newest comment on the PR records it.
export interface LastReview {
  headSha: string;
  // Absent from a review saved before the base was kept.
  baseRef?: string;
}

export interface ReviewTrigger {
  headSha: string;
  baseRef?: string;
  // The run was started by an edit of the PR (title, description or base), not by a push.
  edited: boolean;
  // The edit moved the PR to another base branch.
  baseChanged: boolean;
}

export type OutstandingWork =
  // `full` when the diff's base moved, so what the earlier rounds covered no longer holds.
  // `reason` says why an edit, which usually only re-checks the description, reviews the code.
  { kind: "review"; full: boolean; reason?: string } | { kind: "recheck" };

// What a run owes the PR, read from what was last reviewed and not from which event started it.
// A run that cancelled another, or came after one that failed, then picks up what that one left.
export function outstandingWork(
  trigger: ReviewTrigger,
  last: LastReview | undefined,
): OutstandingWork {
  const retargeted =
    trigger.baseChanged ||
    (last?.baseRef !== undefined &&
      trigger.baseRef !== undefined &&
      last.baseRef !== trigger.baseRef);
  if (!trigger.edited) {
    return {
      kind: "review",
      full: retargeted,
    };
  }
  if (retargeted) {
    return {
      kind: "review",
      full: true,
      reason:
        "The PR's base changed since the last review, so reviewing the whole change again.",
    };
  }
  if (last?.headSha !== trigger.headSha) {
    return {
      kind: "review",
      full: false,
      reason: `${trigger.headSha.slice(0, 7)} has no finished review yet, so reviewing the code.`,
    };
  }
  return { kind: "recheck" };
}
