<!--
AGENTS.md strategy: this file is for coding agents, and it's loaded into every session, so every line costs tokens.
- Include only what an agent can't learn from the code or config and would otherwise get wrong.
- Write imperative, specific rules ("use X, not Y") with exact commands. Leave out overviews and rationale.
- Don't restate what tooling already enforces (lint, format, hooks) or what package.json scripts already show.
- Add a rule when an agent makes a real mistake, and delete rules that no longer earn their place. Keep it under about 40 lines.
- Human-facing docs go in README.md.
-->

# diffcop

## Rules

- Use Bun for everything (`bun`, `bun run`, `bunx`), not node, npm, ts-node, or dotenv. Bun loads `.env` itself. The one exception is `npm publish` in the release workflow.
- Prefer Bun APIs over npm packages: `` Bun.$`git ...` ``, `Bun.file`, `Bun.serve`.
- Parse data from outside the process (GitHub API, event payloads, harness metadata) with a Zod schema, and get its type from `z.infer`. GitHub responses go through `schema.safeParse` and `unwrapResponse`.
- Keep the reviewer agent in `src/agent/claude-code/claude-code-agent.ts` read-only (`read`, `glob`, `grep`, `permissionMode: "allow-reads"`). Never give it write or shell tools.
- To add a subcommand, create `src/commands/<name>.ts` with a default-exported `defineCommand` and lazy-load it from `subCommands` in `src/cli.ts`.

## Comments

Before writing or keeping a comment or JSDoc block, walk this:

1. Can a reader derive it from the code, names, types or test name? Then don't write it. Don't restate a signature in `@param`/`@returns` either; the types already say it.
2. Is there a hidden reason, constraint or exception (an API quirk, a rate limit, a race, why _not_ the obvious approach)? Document that fact only, not what the code does.
3. Keep it to 1 line, 2 at most. Go longer only with a very good reason. Section markers and short field notes in a Zod schema are fine.

## Checks

- Run `bun run check` and make it pass before you commit. CI runs it on every PR too.
- Lint has zero tolerance for warnings. Fix the code. Don't disable a rule or downgrade it to `"warn"`.
- Don't bypass the git hooks (`--no-verify`, `LEFTHOOK=0`).
- Write commit messages as Conventional Commits: `<type>(<scope>): <description>`, e.g. `feat(cli): add --json flag`. commitlint (`commitlint.config.ts`) enforces this on commit.
- Add or update tests for code you change. Put them in `*.test.ts` files next to the source and import from `bun:test`.
- Write new custom lint rules in [oxlint-plugin-deslopify](https://github.com/BrianEstrada/oxlint-deslopify), not in this repo.
- Smoke-test with `bun run diffcop review "review this code"` on a branch with real changes.

## Releasing

- Release only when asked. Preview with `bunx git-cliff --bumped-version` and `bun run release-notes`.
- Run `gh workflow run release.yml --ref main` (add `-f version=X.Y.Z` to override), then `gh run watch`. It publishes to npm, tags the commit and creates the GitHub Release. Never tag, create releases or run `npm publish` by hand.
- Notes come from commit subjects (PR titles after a squash merge): `feat`, `fix`, `perf`, `docs` and breaking changes; the rest is skipped. Use those types only for changes the CLI's or action's users notice.

## PRs

- Title: a Conventional Commit, like the commit messages. A squash merge uses it as the commit message.
- If you change CLI flags or usage, update `README.md`.
