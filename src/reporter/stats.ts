import type { RunStats } from "@/agent/reviewer-agent";

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

export function formatCount(count: number) {
  return compact.format(count);
}

export function formatCost(costUsd: number) {
  return `~$${costUsd.toFixed(2)}`;
}

// Undefined when the share isn't known, or there's nothing to take a share of.
export function formatCached({ inputTokens, cacheReadTokens }: RunStats) {
  if (!inputTokens || !cacheReadTokens) {
    return undefined;
  }
  return percent.format(cacheReadTokens / inputTokens);
}

export function formatStats(stats: RunStats) {
  const parts = [
    formatDuration(stats.durationMs),
    `${stats.toolCalls} tool call${stats.toolCalls === 1 ? "" : "s"}`,
  ];
  if (stats.inputTokens !== undefined) {
    let tokens = `${formatCount(stats.inputTokens)} input tokens`;
    const cached = formatCached(stats);
    if (cached !== undefined) {
      tokens = `${tokens} (${cached} cached)`;
    }
    parts.push(tokens);
  }
  if (stats.outputTokens !== undefined) {
    parts.push(`${formatCount(stats.outputTokens)} output`);
  }
  if (stats.costUsd !== undefined) {
    parts.push(formatCost(stats.costUsd));
  }
  return parts.join(" · ");
}
