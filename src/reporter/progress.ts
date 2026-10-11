export function toolCallLine(toolName: string, input: string) {
  return `› ${toolName} ${input}`;
}

// Shown so slow runs make clear where the time went.
export function thinkingLine(durationMs: number) {
  return `› thinking (${Math.round(durationMs / 1000)}s)`;
}

export function verifyingLine(findings: number) {
  return `› verifying ${findings} finding${findings === 1 ? "" : "s"}…`;
}
