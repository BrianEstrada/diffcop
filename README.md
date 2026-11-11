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

The action reviews each pull request and keeps the result in a single PR comment.

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
  # Title and body edits get a group of their own, so a re-check can't cancel a review of the code.
  group: review-${{ github.event.pull_request.number }}${{ github.event.action == 'edited' && !github.event.changes.base && '-edit' || '' }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

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
| `github-token`            | `github.token`                                                       | Reads the PR and posts the comment.                   |
| `prompt`                  | Review this pull request for bugs, security issues, and regressions. | What to ask the reviewer.                             |
| `effort`                  | `high`                                                               | `low` to `max`. Empty uses Claude Code's default.     |
| `max-chunks`              | `1`                                                                  | `1` to `4`. Above 1, a large diff is split up.        |
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

By default one finder reviews the whole diff. With `--maxChunks` set from 2 to 4 (`max-chunks` in
the action), a diff over 400 changed lines is split by path into that many chunks at most, of about
400 lines each, tests kept with their source; past that, chunks grow. Each chunk gets two finders
of its own, and one more finder reviews the whole diff for bugs that span chunks. Their findings
are merged before they're checked. This costs several times as much as one pass. If one finder or
the merge step fails, the review goes on without it and says so in a warning.

The review opens with one headline:

- 🔴 **N issues found**: high or medium bugs the diff introduced.
- 🟡 **Description doesn't match the diff**: the PR claims something the code doesn't do.
- 🟡 **Only nits**: nothing serious.
- ✅ **All good**: nothing found.

Below it, collapsible sections list the findings, bugs that predate the diff, what verification
dropped and why, what an earlier round settled, and the files the reviewer read.

On a PR, the reviewer also sees the title, description, labels, comments and reviews, sanitized
before they reach the prompt. It treats the description as the author's claims, not as proof.

Editing only the title or description doesn't review the code again. If the last review found
that the description doesn't match the diff, diffcop re-checks just the description and updates
those findings in the comment, keeping the rest of the review. Otherwise it stops without calling
the model. An edit made while a review is running gets the same treatment when that review
finishes. A retargeted base, or a push, still reviews the code.

### Reviewing a change again

diffcop remembers what it found. On a PR it keeps a ledger of every round, hidden in its comment.
For a local run, pass `--ledger <file>` and it keeps the ledger there. A round belongs to a commit,
so reviewing the same commit twice redoes its round.

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
- With `--maxChunks` above 1, the split follows what changed since the last round, so a small fix
  gets one finder.

`--full` (`full` in the action) opens the whole change to low findings and nits again for one
run. diffcop does the same on its own when the last reviewed commit is no longer in the branch's
history, as after a rebase or force-push, and when the PR's base changes.

## Contributing

`bun install` also sets up the git hooks. Run `bun run check` (typecheck, lint, format, tests)
before you open a PR. CI runs the same check on every PR.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), e.g.
`feat(cli): add --json flag`. The commit-msg hook runs commitlint and rejects anything else.
