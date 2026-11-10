import { describe, expect, test } from "bun:test";
import type { Explored } from "@/agent/explored";
import type { AgentRun, ReviewerAgent, RunStats } from "@/agent/reviewer-agent";
import type { ChangedFile, Repository } from "@/context/repository";
import { ReviewContextCollector } from "@/context/review-context-collector";
import { ReviewPromptBuilder } from "@/prompt/review-prompt-builder";
import type { ReviewReporter } from "@/reporter/review-reporter";
import { ChangeSizeLimit } from "@/review/change-size-limit";
import { CodeReviewer } from "@/review/code-reviewer";
import { LINES_PER_CHUNK } from "@/review/diff-chunks";
import { verificationBatches } from "@/review/find-and-verify";
import type { Finding, ReviewResult } from "@/review/findings";

class FakeRepository implements Repository {
  readonly #changedFiles: ChangedFile[];
  // What changed since the last review; undefined when that commit isn't an ancestor of HEAD.
  readonly #delta: string | undefined;

  constructor(changedFiles: ChangedFile[] = [], delta?: string) {
    this.#changedFiles = changedFiles;
    this.#delta = delta;
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

  async headSha() {
    return "abc1234";
  }

  async isAncestor() {
    return this.#delta !== undefined;
  }

  async diffOfFilesSince() {
    return this.#delta ?? "";
  }

  async hashObject() {
    return "0000";
  }
}

// One chunk's worth of changed lines in each file, so each gets its own finder.
function chunkSized(...paths: string[]): ChangedFile[] {
  return paths.map((path) => {
    return {
      path: path,
      additions: LINES_PER_CHUNK,
      deletions: 0,
    };
  });
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

// Each review reads the clock twice, so it measures `elapsedMs` of wall time.
function clock(elapsedMs: number) {
  let reads = 0;
  return () => {
    return reads++ % 2 === 0 ? 0 : elapsedMs;
  };
}

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

  async failed(error: Error, options: { cancelled: boolean }) {
    this.events.push(["failed", error, options]);
  }
}

function createReviewer(
  agent: ReviewerAgent,
  reporter: ReviewReporter,
  changedFiles: ChangedFile[] = [],
  elapsedMs = runStats.durationMs,
  delta?: string,
) {
  return new CodeReviewer(
    new ReviewContextCollector(new FakeRepository(changedFiles, delta)),
    new ReviewPromptBuilder(),
    agent,
    reporter,
    new ChangeSizeLimit({
      maxLines: 100,
      maxFiles: 2,
    }),
    clock(elapsedMs),
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

    const reviewed = await createReviewer(agent, reporter, [], 2_000).review({
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

  test("runs two finders per chunk and one over the whole diff, and verifies their pooled findings", async () => {
    const empty = {
      summary: "",
      findings: [],
    };
    const agent = new FakeAgent([
      {
        summary: "Traced a.",
        findings: [finding("A")],
      },
      {
        summary: "Traced b.",
        findings: [finding("B")],
      },
      empty,
      empty,
      empty,
      { duplicates: [] },
      {
        verdicts: [
          {
            id: 1,
            verdict: "confirmed",
            reason: "Fails.",
          },
          {
            id: 2,
            verdict: "confirmed",
            reason: "Fails.",
          },
        ],
      },
    ]);

    const reviewed = await createReviewer(
      agent,
      new RecordingReporter(),
      chunkSized("a/x.ts", "b/y.ts"),
    ).review({
      request: "x",
      maxChunks: 4,
    });

    expect(
      agent.runs.slice(0, 5).map((run) => {
        return run.prompt.content[1];
      }),
    ).toEqual([
      "<assigned_files>\na/x.ts\n</assigned_files>",
      "<assigned_files>\nb/y.ts\n</assigned_files>",
      "<assigned_files>\na/x.ts\n</assigned_files>",
      "<assigned_files>\nb/y.ts\n</assigned_files>",
      "<user_request>\nx\n</user_request>",
    ]);
    expect(agent.runs[6]?.prompt.content[1]).toContain('"title": "B"');
    expect(reviewed.summary).toBe("Traced a. Traced b.");
    expect(reviewed.findings).toEqual([finding("A"), finding("B")]);
    expect(reviewed.stats.toolCalls).toBe(14);
    expect(
      reviewed.finders?.map(({ files, findings }) => {
        return [files, findings];
      }),
    ).toEqual([
      [["a/x.ts"], 1],
      [["b/y.ts"], 1],
      [["a/x.ts"], 0],
      [["b/y.ts"], 0],
      [undefined, 0],
    ]);
    expect(reviewed.merged).toEqual([]);
  });

  test("merges the finders' duplicates before verifying, and says what it merged", async () => {
    const empty = {
      summary: "",
      findings: [],
    };
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [finding("A")],
      },
      {
        summary: "",
        findings: [finding("A again"), finding("B")],
      },
      empty,
      empty,
      empty,
      {
        duplicates: [
          {
            id: 2,
            duplicateOf: 1,
          },
        ],
      },
      { verdicts: [] },
    ]);

    const reviewed = await createReviewer(
      agent,
      new RecordingReporter(),
      chunkSized("a/x.ts", "b/y.ts"),
    ).review({
      request: "x",
      maxChunks: 4,
    });

    const [merger, verifier] = agent.runs.slice(5);
    expect(merger?.prompt.instructions).toContain("without using tools");
    expect(merger?.prompt.content[0]).toContain('"title": "A again"');
    expect(verifier?.prompt.content[1]).not.toContain("A again");
    expect(verifier?.prompt.content[1]).toContain('"title": "B"');
    expect(reviewed.merged).toEqual([
      {
        finding: finding("A again"),
        into: finding("A"),
      },
    ]);
  });

  test("runs a single finder over a diff of several chunks unless maxChunks asks for more", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [],
      },
    ]);

    const reviewed = await createReviewer(
      agent,
      new RecordingReporter(),
      chunkSized("a/x.ts", "b/y.ts"),
    ).review({ request: "x" });

    expect(agent.runs).toHaveLength(1);
    expect(reviewed.finders).toBeUndefined();
  });

  test("runs a single finder over the whole diff when the change fits one chunk", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [],
      },
    ]);

    const reviewed = await createReviewer(
      agent,
      new RecordingReporter(),
      chunkSized("a/x.ts"),
    ).review({ request: "x" });

    expect(agent.runs).toHaveLength(1);
    expect(agent.runs[0]?.prompt.content[1]).toBe(
      "<user_request>\nx\n</user_request>",
    );
    expect(reviewed.finders).toBeUndefined();
  });

  test("reports the wall time of parallel finders, not their summed durations", async () => {
    const empty = {
      summary: "",
      findings: [],
    };
    const agent = new FakeAgent([empty, empty, empty, empty, empty]);

    const reviewed = await createReviewer(
      agent,
      new RecordingReporter(),
      chunkSized("a/x.ts", "b/y.ts"),
      1_500,
    ).review({
      request: "x",
      maxChunks: 4,
    });

    expect(reviewed.stats.durationMs).toBe(1_500);
    expect(reviewed.stats.costUsd).toBe(1.25);
  });

  test("verifies each file's findings in a session of its own", async () => {
    const inB: Finding = {
      ...finding("B"),
      file: "b.ts",
    };
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [finding("A"), inB],
      },
      {
        verdicts: [
          {
            id: 1,
            verdict: "confirmed",
            reason: "Fails.",
          },
        ],
      },
      {
        verdicts: [
          {
            id: 1,
            verdict: "refuted",
            reason: "Guarded.",
          },
        ],
      },
    ]);

    const reviewed = await createReviewer(
      agent,
      new RecordingReporter(),
    ).review({ request: "x" });

    expect(agent.runs).toHaveLength(3);
    expect(reviewed.findings).toEqual([finding("A")]);
    expect(reviewed.dropped).toEqual([
      {
        finding: inB,
        reason: "Guarded.",
      },
    ]);
  });
});

describe("verificationBatches", () => {
  function at(file: string, startLine: number): Finding {
    return {
      ...finding(`${file}:${startLine}`),
      file: file,
      startLine: startLine,
      endLine: startLine,
    };
  }

  test("groups by file in line order, at most five to a batch", () => {
    const findings = [
      at("a.ts", 9),
      at("b.ts", 1),
      ...[6, 5, 4, 3, 2, 1].map((line) => {
        return at("a.ts", line);
      }),
    ];

    expect(
      verificationBatches(findings).map((batch) => {
        return batch.map((f) => {
          return f.title;
        });
      }),
    ).toEqual([
      ["a.ts:1", "a.ts:2", "a.ts:3", "a.ts:4", "a.ts:5"],
      ["a.ts:6", "a.ts:9"],
      ["b.ts:1"],
    ]);
  });
});

describe("CodeReviewer on a re-review", () => {
  const rounds = [
    {
      headSha: "aaaaaaa",
      entries: [
        {
          ...finding("Raised before"),
          severity: "nit" as const,
          status: "reported" as const,
        },
      ],
    },
  ];

  const changedFiles = [
    {
      path: "a.ts",
      additions: 3,
      deletions: 0,
    },
  ];

  // Only line 1 of a.ts changed since round 1.
  const delta = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");

  function nit(title: string, line: number): Finding {
    return {
      ...finding(title),
      severity: "nit",
      startLine: line,
      endLine: line,
    };
  }

  function answers() {
    return [
      {
        summary: "",
        findings: [nit("On the change", 1), nit("On old code", 3)],
      },
      {
        verdicts: [1, 2].map((id) => {
          return {
            id: id,
            verdict: "confirmed",
            reason: "Accurate.",
          };
        }),
      },
    ];
  }

  test("shows the finder the earlier rounds and keeps nits to what changed since", async () => {
    const agent = new FakeAgent(answers());

    const reviewed = await createReviewer(
      agent,
      new RecordingReporter(),
      changedFiles,
      runStats.durationMs,
      delta,
    ).review({
      request: "x",
      rounds: rounds,
    });

    expect(agent.runs[0]?.prompt.content[0]).toContain(
      "1.1. [reported] nit · a.ts:1-1 · Raised before",
    );
    expect(reviewed.findings).toEqual([nit("On the change", 1)]);
    expect(reviewed.rereview).toEqual({
      since: "aaaaaaa",
      settled: [],
      leftOut: 1,
    });
  });

  test("opens the whole change to nits again when a full review is asked for", async () => {
    const agent = new FakeAgent(answers());

    const reviewed = await createReviewer(
      agent,
      new RecordingReporter(),
      changedFiles,
      runStats.durationMs,
      delta,
    ).review({
      request: "x",
      rounds: rounds,
      full: true,
    });

    expect(agent.runs[0]?.prompt.content[0]).toContain("<previous_rounds>");
    expect(reviewed.findings).toHaveLength(2);
    expect(reviewed.rereview?.since).toBeUndefined();
  });

  test("is a first review without earlier rounds", async () => {
    const agent = new FakeAgent(answers());

    const reviewed = await createReviewer(
      agent,
      new RecordingReporter(),
      changedFiles,
      runStats.durationMs,
      delta,
    ).review({ request: "x" });

    expect(agent.runs[0]?.prompt.content[0]).not.toContain("<previous_rounds>");
    expect(reviewed.findings).toHaveLength(2);
    expect(reviewed.rereview).toBeUndefined();
  });
});
