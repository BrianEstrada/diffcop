<!--
README strategy: this file is for humans deciding whether to use diffcop and getting it running.
- Open with what it is and why in one or two sentences, then a quick start that works when you paste it.
- Show usage by example, not by listing every flag. `diffcop review --help` holds the full reference.
- Give contributors only the single entry point (`bun run check`). Scripts and config files document themselves.
- Agent instructions go in AGENTS.md. Don't duplicate them here.
- If a section grows past a screen, move it to its own doc and link it.
-->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/branding/lockup-dark.svg">
    <img src="docs/branding/lockup.svg" alt="diffcop" width="324">
  </picture>
</p>

# diffcop

An opinionated, local-first AI code reviewer that runs on the coding agent you already use.

diffcop reviews your branch from the terminal through an agent harness, using the subscription
you already pay for, so a review doesn't have to cost you API tokens. It supports Claude Code
today, and support for [Pi](https://github.com/earendil-works/pi),
[Codex](https://github.com/openai/codex) and [OpenCode](https://opencode.ai) is planned.

The agent reviews your diff with read-only tools, a second pass double-checks every finding, and
the same review can run on every pull request as a [GitHub Action](#github-action).

## Quick start

Requires [Bun](https://bun.com) and [Claude Code](https://claude.com/product/claude-code) logged in
with your subscription. Where you can't log in, run `claude setup-token` to get a long-lived token
for your subscription and set it as `CLAUDE_CODE_OAUTH_TOKEN`. To pay per token instead, set
`ANTHROPIC_API_KEY`.

```bash
cd your-repo
bunx diffcop review "review this code"
```

To keep `diffcop` on your PATH, install it with `bun add --global diffcop`. It runs on Bun, so
`npx diffcop` works only where Bun is installed.

## Usage

```bash
diffcop review "focus on error handling"
diffcop review "review this code" --base origin/develop   # default: origin/HEAD, then main
diffcop review "review this code" --cwd ../other-repo
diffcop review "quick pass" --effort low                  # faster, shallower review
diffcop review "review this code" --maxChunks 4           # split a large diff into up to 4 chunks
diffcop review "review this code" --ledger ledger.json    # remember findings between runs
diffcop review "review this code" --reporter json | jq .findings
```

`diffcop review --help` lists every option.

diffcop warns when a diff is too big to review well (over 1,000 changed lines or 20 files, not
counting lockfiles) and suggests splitting it. Change the limits with `--maxLines` and
`--maxFiles`.

## GitHub Action

The action reviews each pull request and posts the result as a PR comment, with the verdict as a
status on the commit.

Run `claude setup-token` to get a token for your Claude subscription and add it as a
`CLAUDE_CODE_OAUTH_TOKEN` repo secret, or add an `ANTHROPIC_API_KEY` secret to pay per token. Then
add this workflow:

```yaml
# .github/workflows/review.yml
name: Review

on:
  pull_request:
    # edited covers a retargeted base, and title or body edits for the description re-check.
    types: [opened, synchronize, reopened, ready_for_review, edited]

concurrency:
  # One group per PR: a run that cancels another picks up whatever that one hadn't finished.
  group: review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write
  statuses: write # for the diffcop status; leave it out and the review still posts

jobs:
  review:
    # Fork PRs don't get secrets, so there's nothing to authenticate with.
    if: ${{ !github.event.pull_request.draft && github.event.pull_request.head.repo.full_name == github.repository }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0 # diffcop needs the merge base with the PR's base branch
          persist-credentials: false

      # Optional: lets the reviewer read your dependencies' code. Scripts are skipped, so no
      # dependency code runs in a job that holds the Claude secrets.
      # - run: npm ci --ignore-scripts

      - uses: BrianEstrada/diffcop@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

| Input                     | Default                                                              | Description                                           |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| `anthropic-api-key`       |                                                                      | Set this or `claude-code-oauth-token`.                |
| `claude-code-oauth-token` |                                                                      | From `claude setup-token`, for Claude subscriptions.  |
| `github-token`            | `github.token`                                                       | Reads the PR, posts the comment and the status.       |
| `prompt`                  | Review this pull request for bugs, security issues, and regressions. | What to ask the reviewer.                             |
| `effort`                  | `high`                                                               | `low` to `max`. Empty uses Claude Code's default.     |
| `max-chunks`              | `4`                                                                  | `1` to `4`. Above 1, a large first review is split.   |
| `full`                    | `false`                                                              | On a re-review, open all of it to minor findings.     |
| `debug`                   | `false`                                                              | Also log the reviewer's tool calls and thinking time. |

The action installs Bun, Node and pnpm on the runner, so later steps in the same job see those
versions.

Install your dependencies before the action, as the commented step does with `npm ci`, so the
reviewer can check how your code uses a library instead of guessing. Use your own package manager's
command (`pnpm install --frozen-lockfile`, `bun install --frozen-lockfile`, …, after its setup
action) and keep `--ignore-scripts`.

## How a review works

The first pass looks for bugs the diff introduced, plus a few nits, and on a PR checks that the
description matches the code. A fresh session then tries to disprove each finding, and only what
survives is reported.

One finder reviews a small diff. A diff over 400 changed lines is split by path into chunks of
about 400 lines each, tests kept with their source, up to `max-chunks` of them: 4 in the action,
and 1 on the command line, where `--maxChunks` raises it. Past that many, chunks grow. Each chunk
gets two finders of its own, and one more finder reviews the whole diff for bugs that span chunks.
Their findings are merged before they're checked. This costs several times as much as one pass,
so only a PR's first review is split this way; [later ones](#reviewing-a-change-again) follow
what changed. If one finder or the merge step fails, the review goes on without it and says so in
a warning.

The review opens with a headline that says what was found and how much of it:

- 🔴 **2 issues, 6 minor findings**: issues are high or medium bugs the diff introduced.
- 🔴 **Description doesn't match the diff**: the PR claims something the code doesn't do.
- 🟡 **6 minor findings**: nothing serious. A minor finding is a low one or a nit.
- ✅ **All good**: nothing found.

Everything below the headline is collapsed. **Findings** lists every reported finding in one
table, issues first. The other sections hold bugs that predate the diff, what verification dropped
and why, what an earlier round settled, and the files the reviewer read. The last one, **Run
details**, has the time, tokens and cost of each run, and how the diff was split: each chunk's
files, changed lines and findings.

The headline is also posted as a commit status named `diffcop` on the PR's head commit, linking to
the comment. It's pending while the review runs, then green when nothing or only minor findings were
found, and red for issues or a description mismatch. A review that fails or is cancelled marks it as
errored. It only blocks merging if you make `diffcop` a required status check; then a PR the
workflow skips, such as a draft or one from a fork, waits for a status that never comes. The status
needs `statuses: write`; without it diffcop says so in the log and posts the comment alone.

Each reviewed commit gets a comment of its own, posted when its review is done, so the
notification carries the result. Earlier diffcop comments are then hidden as outdated: a PR shows
one review, and the earlier rounds stay a click away. Reviewing a commit again edits its comment
instead of posting another. Nothing is posted while a review runs, or when one is cancelled; the
status covers both. A review that fails posts the error, after that commit's review if it has one.

On a PR, the reviewer also sees the title, description, labels, comments and reviews, sanitized
before they reach the prompt. It treats the description as the author's claims, not as proof.

Editing only the title or description doesn't review the code again once the head commit has its
review. If that review found that the description doesn't match the diff, diffcop re-checks just
the description and updates those findings in the comment, keeping the rest of the review.
Otherwise it stops without calling the model. A retargeted base, or a push, still reviews the code.

diffcop decides this from what it last reviewed, not from which event started the run. An edit
that cancels a running review therefore reviews the code itself, because the commit has no
finished review yet, and a commit whose review failed is reviewed again on the next edit. This is
why the workflow keeps one concurrency group per PR: with a group of their own, edits made during a
review would start a second review of the same commit.

### Reviewing a change again

diffcop remembers what it found. On a PR each of its comments keeps that round's findings, hidden
after the review, and the next run reads them back from every comment; hiding a comment doesn't
change that, deleting one forgets its round. For a local run, pass `--ledger <file>` and it keeps
every round there. A round belongs to a commit, so reviewing the same commit twice redoes its
round.

When a change was reviewed before:

- The reviewer sees what the earlier rounds reported and what verification dropped, and is told
  not to raise those again.
- High and medium bugs from the last round are checked again, so one that's still there stays in
  the review.
- A finding that repeats one already dropped, or one the author declined, goes under **Settled in
  an earlier round** instead of being reported. The author's answers are read from the PR
  description and comments, or from an entry's `answer` in a ledger file. A low finding or a nit
  is settled once the author has seen it. A high or medium bug is settled only when the code
  bears out the author's reason.
- Low findings and nits are reported only on lines that changed since the last reviewed commit.
  The footer names that commit.
- The split into chunks follows what changed since the last round, so a small fix gets one
  finder.

`--full` (`full` in the action) reviews the whole change as on a first review for one run:
split into chunks, and open to low findings and nits everywhere. diffcop does the same on its
own when the PR's base changes.

When the last reviewed commit is no longer in the branch's history, as after a rebase or
force-push, there is nothing to compare against. Low findings and nits are open everywhere
again, but one finder reviews the change, so a branch rebased on every push doesn't pay for a
split review each time.

## Contributing

`bun install` also sets up the git hooks. Run `bun run check` (typecheck, lint, format, tests)
before you open a PR. CI runs the same check on every PR.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), e.g.
`feat(cli): add --json flag`. The commit-msg hook runs commitlint and rejects anything else.
