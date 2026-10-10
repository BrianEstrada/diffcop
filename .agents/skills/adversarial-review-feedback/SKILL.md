---
name: adversarial-review-feedback
description: Use this skill when the user wants review feedback on a GitHub PR acted on, whether it comes from Claude, Copilot, CodeRabbit, SonarQube or a human reviewer, and whether it's on the PR or pasted in. It checks every claim against the code, git history and library sources, fixes only what holds up, logs each outcome in the PR description, then commits and pushes. If the PR has no review yet, it triggers the AI reviewer first. Use it for requests like "we got some PR feedback", "more feedback", "fix the review comments" or "handle the review on PR 123", even when the user doesn't name the reviewer. Don't use it to review a PR yourself, to only summarize or judge a review, or to fix CI failures, because it commits and pushes.
---

# Adversarial review of PR feedback

A review is a list of claims, not a list of tasks. AI reviewers are often right, but they also:

- review an older commit and flag things that are already fixed;
- read a comment or a name and assume the behaviour;
- call something "not a regression" without diffing against the base branch;
- guess at framework behaviour;
- predict flakiness that the arithmetic rules out.

Acting on a false claim adds churn and sometimes a bug. Dismissing a true one ships the bug. So every claim gets checked against primary sources before anything changes.

This skill is for GitHub PRs and uses the `gh` CLI. It runs unattended: it commits, pushes, edits the PR description and makes its own scope calls, with no one to ask. The one hard limit: never force-push, rewrite pushed history, push to the base branch, or merge, close or approve the PR.

One run handles one review round.

## 1. Get the review

- **Pasted review:** use it and go to step 2.
- **Otherwise:** find the latest AI review on the PR. Review bodies and PR comments: `gh pr view <n> --json reviews,comments,headRefOid`. Inline threads: `gh api repos/{owner}/{repo}/pulls/<n>/comments --jq '.[] | {id, in_reply_to_id, user: .user.login, path, line, body, commit_id}'`. AI reviewers post from bot accounts or a known reviewer login. Use the review if it ran against the head commit.
- **No review for the head commit yet:** work out how the repo's AI reviewer is started. Check the repo's AGENTS.md, the workflows in `.github/workflows/`, reviewer config files, and how earlier reviews on this and recent PRs were started.
  - **Needs a command** (e.g. a `/review` or `@claude review` comment): post it with `gh pr comment <n> --body '<command>'`, then wait.
  - **Runs on push or on open:** wait. `gh pr checks <n>` shows whether the reviewer's check is still running.
  - Poll every minute or so, for up to 30 minutes or whatever AGENTS.md says. If the review doesn't arrive, stop and report what you triggered and what you saw.
- **No AI reviewer on the repo:** stop. Tell the operator this skill can't run because no AI review mechanism is set up (no reviewer workflow, app or trigger command), and list where you looked. Don't review the PR yourself instead.

## 2. Establish what was reviewed

- Find the branch and PR: `git status`, `git log --oneline <base>..HEAD`, `gh pr view <n> --json title,body,headRefOid,baseRefName`.
- Note the commit the review ran against. Reviews often name it ("run against `4aeb2db`", or a SHA in a link). If it isn't HEAD, expect some findings to be stale.
- Read the full diff against the base (`git diff <base>...HEAD`), not just the files the review mentions. Many claims are about what changed relative to the base.
- Read the PR title and description. Reviews sometimes make claims about them, and your fixes may make parts of them stale. Read the review log at the bottom (step 8) and the existing thread replies too: a finding they already answer may just be re-raised.
- If the repo has a plan or follow-ups file (e.g. `plan.md`, `docs/`), skim it. It shows which known issues are already tracked.

## 3. List every claim

Break the review into atomic, checkable claims. Include the parts that sound like praise or context, not just the numbered findings:

- "What's right" / "Checked, no issues" statements. These are claims too, and a wrong one hides a bug.
- The severity framing: "not a regression", "pre-existing", "optional", "fine as a follow-up".
- Claims about tests: "no test covers X", "this test could flake".
- Claims about the PR description.
- Comments about other reviewers' findings ("the AI reviewer's concern is already covered").

A single finding often bundles several claims ("X isn't measured, and it isn't a regression"). Split them, because they can have different verdicts.

Note where each claim came from: the inline comment id, or the review or PR comment and its finding number. The review log entry links back to it.

## 4. Verify each claim against primary sources

For each claim, find evidence with a file and line or command output:

- **Code behaviour:** read the actual code at HEAD, including callees. Don't trust names or comments, which is exactly what the reviewer may have done.
- **"Not a regression" / "pre-existing" / "same as before":** diff against the base with `git show <base>:<path>`. Pay attention to ordering. On the base, a timer or log line may have covered work that has now moved.
- **"Missing test" / "add a test for X":** grep the test sources at HEAD. If the test exists, the claim is stale or false.
- **Framework or library behaviour** (handshake order, close codes, mock semantics, retry behaviour): read the library source, at the version the project actually resolves. The repo's AGENTS.md should say where library sources live and how to check the resolved version.
- **Flakiness and timing:** reason it through. Does load widen or shrink the margin?
- **Premises:** a conditional suggestion ("if a domain can exist without a default group, keep the old wording") depends on its premise. Check the premise. The old wording may have been wrong all along.

Give each claim one verdict:

- **True**
- **False**
- **Stale**: true on an older commit, already fixed at HEAD.
- **Partly true**: say which part holds.
- **True, framing wrong**: e.g. the reviewer says "not a regression" but it partly is, or says "optional" but it's a real bug.
- **True but bigger than stated**: verifying it uncovered a wider problem.

## 5. Decide what to change

- **True or partly true, in scope:** fix it, nits included. Fix the part that is true, not the reviewer's wording of it.
- **False or stale:** don't change the code. Record why, with evidence, in the review log (step 8).
- **The reviewer's suggested fix is incomplete** (e.g. a guard that only narrows a race): don't apply it as given. Work out what would actually fix it.
- **Pre-existing, broad, or a design decision** (new metric labels, lifecycle or race changes, anything touching code a stacked PR also changes): make the call yourself. If the fix stays within the PR's own changes, make it. If it reaches outside them, log it as **Deferred to follow-up** with the reason, and add it to the repo's follow-ups list (with the mechanism and the intended fix) unless it's already tracked.
- **PR title or description is wrong or now stale:** check both against the branch after your fixes, not just the parts the review mentions, and correct them (step 7).

Follow the repo's conventions: AGENTS.md, memories and code style. Keep diffs minimal, because this is review follow-up, not a refactor. Plan the changes per finding, since each fix is committed on its own (step 7).

## 6. Prove the fixes

- Add or adjust tests for each behaviour change, and check each new test fails without its fix.
- Run the linter and the affected tests, and fix whatever fails before publishing.

## 7. Publish

In this order:

1. **Commit** each fix on its own, following the repo's commit style and attribution rules, so a reviewer can check
   every addressed finding as one commit on GitHub:
   - One commit per finding fixed, holding the fix and its test. Findings that share one fix share its commit, and
     a finding that needs unrelated changes gets one commit per change.
   - The message says what changed and why, and names the finding it addresses (e.g. `Review round 2, #3`).
   - Keep changes that aren't fixes (description-driven renames, lint-only formatting) out of the fix commits, in a
     commit of their own.
   - Each commit should build and pass its tests on its own. Run the linter's formatter before committing, so its
     changes land in the commit they belong to.
2. **Update the PR:** apply title and description corrections and the new review log round (step 8) with `gh pr edit`, and reply to human reviewers' threads. The next AI review reads the description when it starts, so this goes before the push.
3. **Push** all the round's commits at once, in a single push, so the round triggers one review rather than one per
   commit. Don't trigger the next review; the next run does that in step 1.
4. **Stacked PRs:** `gh pr list --base <this-branch>`. If other PRs build on this branch, they need a restack. Report it; don't restack or force-push them.

## 8. Record every finding in the review log

Don't reply to AI reviewers' findings in threads or PR comments. Record each one in a review log section at the very bottom of the PR description instead. A finding with no answer comes back on the next review, and one answered with evidence usually doesn't.

The log is append-only: it is always updated, never removed.

- Keep it last in the body, between `<!-- review-log:start -->` and `<!-- review-log:end -->`. Create it on the first round.
- Each round adds a new `### Round <n>: review of <sha>` block below the previous ones. Never delete or reword earlier rounds or entries.
- If a later round changes an earlier outcome (a deferred finding gets fixed, a "won't fix" turns out wrong), add a line to the new round that references the old entry (`Round 1 #3: now fixed in ...`) rather than editing it.
- Any other description edit (step 5) keeps the log byte-for-byte. Diff the old and new body and check that nothing between the markers changed except the appended round.

```markdown
<!-- review-log:start -->

## Review feedback log

### Round 1: review of `4aeb2db`

| #   | Finding                                    | Outcome                                                                    |
| --- | ------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | [Race in session close](<link to comment>) | **Fixed** in `a1b2c3d`: <what changed>. Covered by `<test name>`.          |
| 2   | [No test for X](link)                      | **Won't fix:** stale, `XSpec` covers it since `9f1c2e0`.                   |
| 3   | [Metric labels](link)                      | **Deferred to follow-up:** <follow-ups file or ticket>; <one-line reason>. |

<!-- review-log:end -->
```

- **How:** `gh pr view <n> --json body --jq .body > <tmp>/body.md`, add the round, and apply with `gh pr edit <n> --body-file <tmp>/body.md`. Re-fetch the body just before applying and redo the append if it changed, so a concurrent edit isn't lost.
- **Fixed:** the commit, what changed and the test that covers it. Fix the true part only, and say which part you left alone.
- **Won't fix (false or stale):** why the finding doesn't apply, with the evidence from step 4 (`path:line` at HEAD, the base-branch diff, or the library source and its version). A stale finding names the commit that already fixed it. Keep it factual, because the entry is the record that stops the next run re-raising it.
- **Deferred to follow-up:** name where it's tracked, and give the one-line reason.
- **Style:** a sentence or two per entry, plain and direct. Don't thank the reviewer, don't defend the code beyond the evidence, and don't add attribution footers.
- **Human reviewers** don't re-read the description, so their inline threads also get a short reply in place (`gh api repos/{owner}/{repo}/pulls/<n>/comments/<comment-id>/replies -f body=...`).

Group the "checked, no issues" claims that held into no entry at all. Add one only when it was wrong and you fixed what it hid.

## 9. Report

The run ends with a report for whoever reads it later. Start with the outcome in a sentence or two. Then give a table with one row per claim, and group the "checked, no issues" claims into one row when they all hold:

| #   | Claim | Verdict and evidence |
| --- | ----- | -------------------- |

Then:

- **Changes:** what changed, where, the commit, and the test that covers it (and that it fails without the fix).
- **Not changed:** each false or stale claim, and each true claim you deferred, with the reason.
- **Scope calls:** each finding you fixed or deferred on your own judgement (step 5), and why.
- **Lint and tests:** what ran and the counts; say plainly what you didn't run.
- **Published:** the pushed commits (one per fixed finding), the title and description changes, and the thread replies to human reviewers.
- **Stacked PRs:** any that need a restack.
- **Stopped early:** if a missing review stopped the run, say why and what the operator needs to do.
