# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub's vulnerability reporting](https://github.com/BrianEstrada/diffcop/security/advisories/new),
not in a public issue or pull request. Expect a first reply within a week.

Only the latest commit on `main` gets fixes.

## What counts

diffcop feeds untrusted text (diffs, PR titles, descriptions and comments) to a coding agent, so
these are in scope:

- PR content that gets the reviewer to write files, run commands or reach tools beyond `read`,
  `glob` and `grep`.
- PR content that leaks a secret (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN`)
  into a review comment, the logs or anywhere else.
- Input that gets past the sanitizing in `src/prompt/github/sanitize-content.ts`.
- Anything in `action.yml` that lets a pull request run its own code with the workflow's
  permissions.

Prompt injection that only changes what the review says (a missed bug, a false all-clear) is a
reviewer-quality issue. Open a regular issue for that.
