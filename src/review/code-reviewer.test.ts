import { describe, expect, test } from "bun:test";
import type { Explored } from "../agent/explored";
import type {
  AgentRun,
  ReviewerAgent,
  RunStats,
} from "../agent/reviewer-agent";
import type { ChangedFile, Repository } from "../context/repository";
import { ReviewContextCollector } from "../context/review-context-collector";
import { ReviewPromptBuilder } from "../prompt/review-prompt-builder";
import type { ReviewReporter } from "../reporter/review-reporter";
import { ChangeSizeLimit } from "./change-size-limit";
import { CodeReviewer } from "./code-reviewer";
import type { Finding, ReviewResult } from "./findings";

class FakeRepository implements Repository {
  readonly #changedFiles: ChangedFile[];

  constructor(changedFiles: ChangedFile[] = []) {
    this.#changedFiles = changedFiles;
  }

  async root() {
    return "/repo";
  }

  async defaultBase() {
    return "main";
  }

  async mergeBase() {
    return "abc123";
  }

  async currentBranch() {
    return "feature";
  }

  async commitsSince() {
    return [];
  }

  async changedFilesSince() {
    return this.#changedFiles;
  }

  async diffSince() {
    return "+change";
  }

  async hashObject() {
    return "0000";
  }
}

function finding(title: string): Finding {
  return {
    file: "a.ts",
    startLine: 1,
    endLine: 1,
    severity: "high",
    scope: "introduced",
    title: title,
    explanation: "Throws on [].",
  };
}

const runStats: RunStats = {
  durationMs: 1_000,
  toolCalls: 2,
  inputTokens: 100,
  costUsd: 0.25,
};

// Each run reads one shared file and one of its own.
function explored(run: number): Explored {
  return {
    filesRead: ["a.ts", `run-${run}.ts`],
    searches: [{ pattern: "sumStats" }],
  };
}

// Answers each run with the next scripted output, parsed by the run's schema
// like the real agent does.
class FakeAgent implements ReviewerAgent {
  readonly runs: AgentRun<unknown>[] = [];
  readonly #answers: unknown[];
  readonly #error: Error | undefined;

  constructor(answers: unknown[], error?: Error) {
    this.#answers = answers;
    this.#error = error;
  }

  async run<T>(run: AgentRun<T>) {
    this.runs.push(run);
    if (this.#error) {
      throw this.#error;
    }
    return {
      output: run.output.parse(this.#answers[this.runs.length - 1]),
      stats: runStats,
      explored: explored(this.runs.length),
    };
  }
}

class RecordingReporter implements ReviewReporter {
  readonly events: unknown[][] = [];

  async started() {
    this.events.push(["started"]);
  }

  async warning(message: string) {
    this.events.push(["warning", message]);
  }

  toolCall() {}

  thinking() {}

  async verifying(findings: number) {
    this.events.push(["verifying", findings]);
  }

  async completed(completed: ReviewResult) {
    this.events.push(["completed", completed]);
  }

  async failed(error: unknown, options: { cancelled: boolean }) {
    this.events.push(["failed", error, options]);
  }
}

function createReviewer(
  agent: ReviewerAgent,
  reporter: ReviewReporter,
  changedFiles: ChangedFile[] = [],
) {
  return new CodeReviewer(
    new ReviewContextCollector(new FakeRepository(changedFiles)),
    new ReviewPromptBuilder(),
    agent,
    reporter,
    new ChangeSizeLimit({
      maxLines: 100,
      maxFiles: 2,
    }),
  );
}

describe("CodeReviewer", () => {
  test("runs the finder at the repo root with the built prompt", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [],
      },
    ]);
    const reporter = new RecordingReporter();
    const abort = new AbortController();

    await createReviewer(agent, reporter).review({
      request: "check errors",
      abortSignal: abort.signal,
    });

    const [run] = agent.runs;
    expect(run?.cwd).toBe("/repo");
    expect(run?.abortSignal).toBe(abort.signal);
    expect(run?.reporter).toBe(reporter);
    expect(run?.prompt.content[0]).toContain("<diff>\n+change\n</diff>");
    expect(run?.prompt.content[1]).toBe(
      "<user_request>\ncheck errors\n</user_request>",
    );
  });

  test("skips verification when the finder finds nothing", async () => {
    const agent = new FakeAgent([
      {
        summary: "Traced the diff.",
        findings: [],
      },
    ]);
    const reporter = new RecordingReporter();

    const reviewed = await createReviewer(agent, reporter).review({
      request: "x",
    });

    const expected: ReviewResult = {
      summary: "Traced the diff.",
      findings: [],
      dropped: [],
      explored: explored(1),
      stats: runStats,
    };
    expect(reviewed).toEqual(expected);
    expect(agent.runs).toHaveLength(1);
    expect(reporter.events).toEqual([["started"], ["completed", expected]]);
  });

  test("reports the findings verification confirms and why it dropped the rest", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [finding("A"), finding("B"), finding("C")],
      },
      {
        verdicts: [
          {
            id: 1,
            verdict: "refuted",
            reason: "Guarded by the caller.",
          },
          {
            id: 2,
            verdict: "confirmed",
            reason: "Fails on [].",
          },
        ],
      },
    ]);
    const reporter = new RecordingReporter();

    const reviewed = await createReviewer(agent, reporter).review({
      request: "x",
    });

    const expected: ReviewResult = {
      summary: "",
      findings: [finding("B")],
      dropped: [
        {
          finding: finding("A"),
          reason: "Guarded by the caller.",
        },
        {
          finding: finding("C"),
          reason: "No verdict returned",
        },
      ],
      explored: {
        filesRead: ["a.ts", "run-1.ts", "run-2.ts"],
        searches: [{ pattern: "sumStats" }],
      },
      stats: {
        durationMs: 2_000,
        toolCalls: 4,
        inputTokens: 200,
        costUsd: 0.5,
      },
    };
    expect(reviewed).toEqual(expected);
    expect(reporter.events).toEqual([
      ["started"],
      ["verifying", 3],
      ["completed", expected],
    ]);
  });

  test("verifies in a second run that sees the context and the findings", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [finding("A")],
      },
      { verdicts: [] },
    ]);

    await createReviewer(agent, new RecordingReporter()).review({
      request: "check errors",
    });

    expect(agent.runs).toHaveLength(2);
    const [finder, verifier] = agent.runs;
    expect(verifier?.cwd).toBe("/repo");
    expect(verifier?.prompt.instructions).toContain("try to disprove it");
    expect(verifier?.prompt.content[0]).toBe(finder?.prompt.content[0]);
    expect(verifier?.prompt.content[1]).toContain('"id": 1');
    expect(verifier?.prompt.content[1]).toContain('"title": "A"');
  });

  test("fails when the agent's answer doesn't match the schema", async () => {
    const reporter = new RecordingReporter();

    expect(
      createReviewer(new FakeAgent([{ issues: [] }]), reporter).review({
        request: "x",
      }),
    ).rejects.toThrow();
    expect(reporter.events.at(-1)?.[0]).toBe("failed");
  });

  test("warns about a large change before running the agent", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [],
      },
    ]);
    const reporter = new RecordingReporter();
    reporter.warning = async (message) => {
      reporter.events.push(["warning", message, agent.runs.length]);
    };

    await createReviewer(agent, reporter, [
      {
        path: "a.ts",
        additions: 150,
        deletions: 0,
      },
    ]).review({ request: "x" });

    expect(
      reporter.events.map(([event]) => {
        return event;
      }),
    ).toEqual(["started", "warning", "completed"]);
    const [, message, runsBefore] = reporter.events[1] ?? [];
    expect(message).toStartWith("This change is large: 150 lines");
    expect(runsBefore).toBe(0);
  });

  test("doesn't warn about a change within the limits", async () => {
    const reporter = new RecordingReporter();

    await createReviewer(
      new FakeAgent([
        {
          summary: "",
          findings: [],
        },
      ]),
      reporter,
      [
        {
          path: "a.ts",
          additions: 100,
          deletions: 0,
        },
      ],
    ).review({ request: "x" });

    expect(reporter.events).toEqual([
      ["started"],
      [
        "completed",
        {
          summary: "",
          findings: [],
          dropped: [],
          explored: explored(1),
          stats: runStats,
        },
      ],
    ]);
  });

  test("reports a failure and rethrows the original error", async () => {
    const error = new Error("boom");
    const reporter = new RecordingReporter();

    expect(
      createReviewer(new FakeAgent([], error), reporter).review({
        request: "x",
      }),
    ).rejects.toBe(error);
    expect(reporter.events).toEqual([
      ["started"],
      ["failed", error, { cancelled: false }],
    ]);
  });

  test("reports a failure and rethrows when the review can't be posted", async () => {
    const error = new Error("502 Bad gateway");
    const reporter = new RecordingReporter();
    reporter.completed = async () => {
      throw error;
    };

    expect(
      createReviewer(
        new FakeAgent([
          {
            summary: "",
            findings: [],
          },
        ]),
        reporter,
      ).review({
        request: "x",
      }),
    ).rejects.toBe(error);
    expect(reporter.events).toEqual([
      ["started"],
      ["failed", error, { cancelled: false }],
    ]);
  });

  test("marks a failure after an abort as cancelled", async () => {
    const abort = new AbortController();
    abort.abort();
    const reporter = new RecordingReporter();

    expect(
      createReviewer(new FakeAgent([], new Error("aborted")), reporter).review({
        request: "x",
        abortSignal: abort.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(reporter.events.at(-1)?.[2]).toEqual({ cancelled: true });
  });
});
