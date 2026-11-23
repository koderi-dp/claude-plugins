# Trellis WORKFLOW.md (invented)

Invented text for the migration tests, in the shape of a docs/WORKFLOW.md that states its process in prose: an auto-merge section and an environment section. Trellis is a made-up booking service for clinics.

## 5. Auto-merge mode

Auto-merge is on (the user approved it at the start, paused it on 2026-10-22 for PR #10, which
they then asked the lead to merge, and turned it back on the next day with "if it passes,
merge it from now on"). The lead merges a slice's or a fix's PR itself when **all** of these hold:

- CI is green on the head commit and the PR is mergeable. A PR that changes only `docs/**`,
  `README.md`, `CLAUDE.md` or `LICENSE` runs no CI (the workflow's `paths-ignore`, 2026-10-26); it
  merges once the lead has checked it is mergeable and nothing outside those paths changed.
  Any other PR runs the `Changed areas` job first (`.github/scripts/changed-areas.sh`): the server,
  web and container jobs whose paths the PR leaves untouched show as skipped, and a skipped
  job counts as green. A push to `main` runs every job.
- The final review has no open Critical or Important finding.
- Every parked item has a ruling in the ledger.
- The lead ran `make check` and `make gen-check` on the head itself.

Merge with a merge commit. After each merge, post a short summary: what shipped, the
rulings made, what is parked, and how many tokens the slice's subagents used. Then start
the next slice without waiting.

Plans are still written to `docs/superpowers/plans/` but the lead does not pause for
review of them.

**Stop and ask the user only for:** product decisions the spec leaves open; security
trade-offs; CI that cannot be made green; anything touching credentials, external
services, or cost outside the session (new hosted dependencies, paid APIs). If GitHub
refuses a merge, say so and fall back to a normal PR for the user to merge.

**Pause** when the user asks (usually for a usage limit): finish the current task, leave
the branch pushed and the ledger current, cancel any scheduled check-ins, unsubscribe from
PR events, and say what the next command is.

## 7. Environment

- Database tests: start Postgres in the container with `service postgresql start`, then
  export `TL_TEST_DATABASE_URL='postgres://user:pass@localhost:5432/trellis?sslmode=disable'`.
  Tests skip silently when it is unset, which makes a red test look green; the lead checks
  that the database tests ran.
- `make tools` installs the pinned code generator; `make gen` regenerates everything; commit the
  output.
- A container restart ends background agents without a word and the task clock keeps running.
  Implementers commit as soon as tests pass, not at the end; the lead dispatches again from
  the working tree that is left. Give every long command a timeout.
- Worktrees live in Claude Code's default place, `.claude/worktrees/` inside the clone (the user's
  layout since 2026-10-29; `.gitignore` and `.dockerignore` exclude it). A lead session creates
  its slice worktree with the `EnterWorktree` tool and a `name` (`.claude/worktrees/<slice>`),
  renames the generated branch to `feat/<slice>` (`git branch -m`), and removes it with
  `ExitWorktree` (`remove`) after the merge. A second lead session is started from the clone
  and does the same with its own name.
- Parallel tasks each get their own git worktree of the one clone, under
  `.claude/worktrees/<slice>-t<N>` on a local branch `feat/<slice>-t<N>` made from the slice head
  (`git worktree add .claude/worktrees/<slice>-t<N> -b feat/<slice>-t<N> <sha>`, then `npm ci` in its
  `web/`); the lead merges the task commit into the slice branch after review, then removes the worktree
  and deletes the local branch. A reviewer's own checkout goes under the session's temporary directory
  and the reviewer removes it.
- The slice worktree is shared with the running implementer. The lead commits its own
  docs changes there with explicit paths (`git add <file>` then `git commit`, never `-a`),
  or waits for the hand-back: a `commit -a` once took an implementer's unfinished edits
  into a docs commit and the history had to be rebuilt before the review.
- Token usage: the session cannot see the plan's usage; it reports the tokens its
  subagents used per task and per slice, which is what the ledger records.

