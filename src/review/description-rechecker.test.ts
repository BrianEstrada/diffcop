import { describe, expect, test } from "bun:test";
import type { AgentRun, ReviewerAgent, RunStats } from "@/agent/reviewer-agent";
import type { PullRequestData } from "@/context/github/pull-request-data";
import type { ChangedFile, Repository } from "@/context/repository";
import { ReviewContextCollector } from "@/context/review-context-collector";
import { ReviewPromptBuilder } from "@/prompt/review-prompt-builder";
import type { ReviewReporter } from "@/reporter/review-reporter";
import { DescriptionRechecker } from "@/review/description-rechecker";
import type { SavedReviewStore } from "@/review/description-rechecker";
import { FindAndVerify } from "@/review/find-and-verify";
import type { Finding, Scope } from "@/review/findings";
import type { SavedReview } from "@/review/saved-review";

class FakeRepository implements Repository {
  readonly mergeBases: string[] = [];

  async root() {
    return "/repo";
  }

  async defaultBase() {
    return "main";
  }

  async mergeBase(base: string) {
    this.mergeBases.push(base);
    return "abc123";
  }

  async currentBranch() {
    return "feature";
  }

  async commitsSince() {
    return [];
  }

  async changedFilesSince(): Promise<ChangedFile[]> {
    return [];
  }

  async diffSince() {
    return "+change";
  }

  async hashObject() {
    return "0000";
  }
}

const pullRequest: PullRequestData = {
  repo: "owner/repo",
  number: 7,
  action: "edited",
  title: "Add a cache",
  body: "Adds a cache in front of the API.",
  author: { login: "octocat" },
  headRefName: "feature",
  baseRefName: "main",
  state: "OPEN",
  additions: 1,
  deletions: 0,
  labels: { nodes: [] },
  commits: { totalCount: 1 },
  files: null,
  comments: { nodes: [] },
  reviews: { nodes: [] },
};

function finding(title: string, scope: Scope): Finding {
  return {
    file: "a.ts",
    startLine: 1,
    endLine: 1,
    severity: "low",
    scope: scope,
    title: title,
    explanation: "Explained.",
  };
}

const reviewStats: RunStats = {
  durationMs: 60_000,
  toolCalls: 20,
};

const recheckStats: RunStats = {
  durationMs: 5_000,
  toolCalls: 2,
};

const bug = finding("Throws on []", "introduced");
const staleClaim = finding(
  "Claims a retry the diff doesn't add",
  "description",
);

function saved(overrides: Partial<SavedReview> = {}): SavedReview {
  return {
    version: 1,
    headSha: "head1",
    descriptionAt: "2026-10-02T10:00:00Z",
    warnings: [],
    result: {
      summary: "Traced the diff.",
      findings: [bug, staleClaim],
      dropped: [
        {
          finding: finding("Refuted bug", "introduced"),
          reason: "Guarded.",
        },
        {
          finding: finding("Refuted claim", "description"),
          reason: "The diff does it.",
        },
      ],
      explored: {
        filesRead: ["a.ts"],
        searches: [],
      },
      stats: reviewStats,
    },
    ...overrides,
  };
}

// `current` is what the comment holds by the time the re-check writes, if something replaced it meanwhile.
class MemoryStore implements SavedReviewStore {
  review: SavedReview | undefined;
  readonly #current: SavedReview | undefined;
  recheck: RunStats | undefined;

  constructor(review: SavedReview | undefined, current = review) {
    this.review = review;
    this.#current = current;
  }

  async load() {
    return this.review;
  }

  async save(
    update: (current: SavedReview) => SavedReview | undefined,
    recheck: RunStats,
  ) {
    const updated = this.#current && update(this.#current);
    if (!updated) {
      return false;
    }
    this.review = updated;
    this.recheck = recheck;
    return true;
  }
}

class FakeAgent implements ReviewerAgent {
  readonly runs: AgentRun<unknown>[] = [];
  readonly #answers: unknown[];

  constructor(answers: unknown[]) {
    this.#answers = answers;
  }

  async run<T>(run: AgentRun<T>) {
    this.runs.push(run);
    return {
      output: run.output.parse(this.#answers[this.runs.length - 1]),
      stats: recheckStats,
      explored: {
        filesRead: [`run-${this.runs.length}.ts`],
        searches: [],
      },
    };
  }
}

const silent: ReviewReporter = {
  started: async () => {},
  warning: async () => {},
  toolCall: () => {},
  thinking: () => {},
  verifying: async () => {},
  completed: async () => {},
  failed: async () => {},
};

const edit = {
  headSha: "head1",
  descriptionAt: "2026-10-02T11:00:00Z",
};

function rechecker(
  agent: ReviewerAgent,
  store: SavedReviewStore,
  repository = new FakeRepository(),
) {
  const promptBuilder = new ReviewPromptBuilder();
  return new DescriptionRechecker(
    new ReviewContextCollector(repository, {
      fetch: async () => {
        return pullRequest;
      },
    }),
    promptBuilder,
    new FindAndVerify(promptBuilder, agent, silent),
    store,
  );
}

describe("DescriptionRechecker", () => {
  test.each([
    [
      "no finished review is saved",
      undefined,
      "the comment holds no finished review to re-check",
    ],
    [
      "the review was of another commit",
      saved({ headSha: "head0" }),
      "the last review was of head0, not head1",
    ],
    [
      "the review found nothing wrong with the description",
      saved({
        result: {
          ...saved().result,
          findings: [bug],
        },
      }),
      "the last review found nothing wrong with the description",
    ],
  ])(
    "skips without asking the model when %s",
    async (_case, review, reason) => {
      const agent = new FakeAgent([]);
      const store = new MemoryStore(review);

      const outcome = await rechecker(agent, store).recheck(edit);

      expect(outcome).toEqual({
        status: "skipped",
        reason: reason,
      });
      expect(agent.runs).toEqual([]);
      expect(store.review).toBe(review);
    },
  );

  test("asks about the new description, showing the description findings it replaces", async () => {
    const agent = new FakeAgent([
      {
        summary: "",
        findings: [],
      },
    ]);

    await rechecker(agent, new MemoryStore(saved())).recheck(edit);

    const content = agent.runs[0]?.prompt.content ?? [];
    expect(content[0]).toContain("Adds a cache in front of the API.");
    expect(content[1]).toContain(staleClaim.title);
    expect(content[1]).not.toContain(bug.title);
  });

  test("diffs against the base the review was given", async () => {
    const repository = new FakeRepository();

    await rechecker(
      new FakeAgent([
        {
          summary: "",
          findings: [],
        },
      ]),
      new MemoryStore(saved()),
      repository,
    ).recheck(edit, { base: "origin/release" });

    expect(repository.mergeBases).toEqual(["origin/release"]);
  });

  test("swaps in the verified description findings and keeps the code findings as reviewed", async () => {
    const newClaim = finding(
      "Claims a cache the diff doesn't add",
      "description",
    );
    const agent = new FakeAgent([
      {
        summary: "Checked the description.",
        findings: [newClaim, finding("A new bug", "introduced")],
      },
      {
        verdicts: [
          {
            id: 1,
            verdict: "confirmed",
            reason: "No cache in the diff.",
          },
        ],
      },
    ]);
    const store = new MemoryStore(saved());

    const outcome = await rechecker(agent, store).recheck(edit);

    expect(outcome).toEqual({
      status: "rechecked",
      findings: 1,
    });
    const expected: SavedReview = {
      ...saved(),
      descriptionAt: "2026-10-02T11:00:00Z",
      result: {
        ...saved().result,
        findings: [bug, newClaim],
        dropped: [saved().result.dropped[0]!],
        explored: {
          filesRead: ["a.ts", "run-1.ts", "run-2.ts"],
          searches: [],
        },
      },
    };
    expect(store.review).toEqual(expected);
    expect(store.recheck).toEqual({
      durationMs: 10_000,
      toolCalls: 4,
    });
  });

  test("clears the description findings when the edit fixed them", async () => {
    const store = new MemoryStore(saved());

    const outcome = await rechecker(
      new FakeAgent([
        {
          summary: "",
          findings: [],
        },
      ]),
      store,
    ).recheck(edit);

    expect(outcome).toEqual({
      status: "rechecked",
      findings: 0,
    });
    expect(store.review?.result.findings).toEqual([bug]);
  });

  test.each([
    [
      "a newer edit was re-checked first",
      saved({ descriptionAt: "2026-10-02T12:00:00Z" }),
    ],
    ["a push was reviewed meanwhile", saved({ headSha: "head2" })],
  ])("leaves the comment alone when %s", async (_case, current) => {
    const store = new MemoryStore(saved(), current);

    const outcome = await rechecker(
      new FakeAgent([
        {
          summary: "",
          findings: [],
        },
      ]),
      store,
    ).recheck(edit);

    expect(outcome).toEqual({ status: "superseded" });
    expect(store.review).toEqual(saved());
  });
});
