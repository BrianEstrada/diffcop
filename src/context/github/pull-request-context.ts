import { z } from "zod";

export interface PullRequestContext {
  apiUrl: string;
  repo: string;
  number: number;
  headSha: string;
  // Title and body as of the event, so edits made after it can't reach the prompt.
  title: string;
  body: string;
  action?: string;
  // Comments and reviews created or edited from this time on are left out.
  triggerTime?: string;
  runId?: string;
  runUrl?: string;
}

const pullRequestEvent = z.object({
  action: z.string().optional(),
  pull_request: z.object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullish(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    head: z.object({ sha: z.string() }),
  }),
});

// Same rule as claude-code-action's extractTriggerTimestamp for pull_request
// events: an opened PR's creation, otherwise its last update (the push).
function triggerTime(
  action: string | undefined,
  pullRequest: { created_at?: string; updated_at?: string },
) {
  if (action === "opened") {
    return pullRequest.created_at ?? pullRequest.updated_at;
  }
  return pullRequest.updated_at ?? pullRequest.created_at;
}

export async function readPullRequestContext(
  env: Record<string, string | undefined> = process.env,
): Promise<PullRequestContext | undefined> {
  const { GITHUB_ACTIONS, GITHUB_EVENT_PATH, GITHUB_REPOSITORY } = env;
  if (GITHUB_ACTIONS !== "true" || !GITHUB_EVENT_PATH || !GITHUB_REPOSITORY) {
    return undefined;
  }

  // An unreadable or malformed payload counts as "not a pull request" too.
  const event = pullRequestEvent.safeParse(
    await Bun.file(GITHUB_EVENT_PATH)
      .json()
      .catch(() => {
        return undefined;
      }),
  );
  if (!event.success) {
    return undefined;
  }

  const { action, pull_request: pullRequest } = event.data;
  const runId = env.GITHUB_RUN_ID;
  const serverUrl = env.GITHUB_SERVER_URL ?? "https://github.com";
  let runUrl: string | undefined;
  if (runId) {
    runUrl = `${serverUrl}/${GITHUB_REPOSITORY}/actions/runs/${runId}`;
  }
  return {
    apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    repo: GITHUB_REPOSITORY,
    number: pullRequest.number,
    headSha: pullRequest.head.sha,
    title: pullRequest.title,
    body: pullRequest.body ?? "",
    action: action,
    triggerTime: triggerTime(action, pullRequest),
    runId: runId,
    runUrl: runUrl,
  };
}
