import type { RunStats } from "../agent/reviewer-agent";

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const percent = new Intl.NumberFormat("en", { style: "percent" });

export function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatInputTokens(inputTokens: number, cacheReadTokens = 0) {
  const tokens = `${compact.format(inputTokens)} input tokens`;
  if (inputTokens === 0 || cacheReadTokens === 0) {
    return tokens;
  }
  return `${tokens} (${percent.format(cacheReadTokens / inputTokens)} cached)`;
}

export function formatStats(stats: RunStats) {
  const parts = [
    formatDuration(stats.durationMs),
    `${stats.toolCalls} tool call${stats.toolCalls === 1 ? "" : "s"}`,
  ];
  if (stats.inputTokens !== undefined) {
    parts.push(formatInputTokens(stats.inputTokens, stats.cacheReadTokens));
  }
  if (stats.outputTokens !== undefined) {
    parts.push(`${compact.format(stats.outputTokens)} output`);
  }
  if (stats.costUsd !== undefined) {
    parts.push(`~$${stats.costUsd.toFixed(2)}`);
  }
  return parts.join(" · ");
}
