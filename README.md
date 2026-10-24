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
| `debug`                   | `false`                                                              | Also log the reviewer's tool calls and thinking time. |

The action installs Bun, Node and pnpm on the runner, so later steps in the same job see those
versions.

## How a review works

The first pass looks for bugs the diff introduced, plus a few nits, and on a PR checks that the
description matches the code. A second, fresh session then tries to disprove each finding, and
only what survives is reported.

The review opens with one headline:

- 🔴 **N issues found**: high or medium bugs the diff introduced.
- 🟡 **Description doesn't match the diff**: the PR claims something the code doesn't do.
- 🟡 **Only nits**: nothing serious.
- ✅ **All good**: nothing found.

Below it, collapsible sections list the findings, bugs that predate the diff, what verification
dropped and why, and the files the reviewer read.

On a PR, the reviewer also sees the title, description, labels, comments and reviews, sanitized
before they reach the prompt. It treats the description as the author's claims, not as proof.

Editing only the title or description doesn't review the code again. If the last review found
that the description doesn't match the diff, diffcop re-checks just the description and updates
those findings in the comment, keeping the rest of the review. Otherwise it stops without calling
the model. An edit made while a review is running is re-checked when that review finishes. A
retargeted base, or a push, still gets a full review.

## Contributing

`bun install` also sets up the git hooks. Run `bun run check` (typecheck, lint, format, tests)
before you open a PR. CI runs the same check on every PR.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), e.g.
`feat(cli): add --json flag`. The commit-msg hook runs commitlint and rejects anything else.
