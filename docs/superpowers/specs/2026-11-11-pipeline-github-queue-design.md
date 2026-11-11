# pipeline: GitHub issues as the queue, records out of git

Status: draft from the brainstorm of 2026-11-11. Decisions below were taken in that conversation. First of three specs; the other two (factory judgment, per-run profiles and parallel slices) are named in section 10 and not designed here.

## 1. Purpose

The pipeline owns its queue: `docs/pipeline/backlog.json` is the list, and every item's spec, plan and ledger are committed to the repository. That fits a project where Claude holds the list. It does not fit a project whose work already sits in a tracker:

- The backlog duplicates the tracker, and nothing keeps the two in step.
- Every PR carries its plan and ledger beside the code, and the tool commits records on the item's branch at each accepted task and on the main branch at close. On catalo, `docs/pipeline/plans` and `docs/pipeline/ledgers` hold a file or folder per item on `main`.
- Nobody outside the machine sees a question the pipeline has, or what it decided to build, until the PR.

This spec adds a second queue mode, `queue: github`, in which open GitHub issues carrying a label are the queue, the spec lives on the issue, and every working file stays on the machine under `.git/pipeline/`. `queue: file` is today's behaviour and does not change.

Who it is for: the user of a GitHub repository whose requests are issues, who wants the pipeline's build loop without a second backlog and without pipeline files in the repository.

### Non-goals

- No Azure DevOps adapter. The tracker module (section 7) is the seam for one.
- No GitHub Projects: no board columns, no manual order.
- No judging intake (accept, rescope, reject), no risk routing, no specialist reviewers, no approver. Second spec.
- No per-run speed profiles, no parallel slices inside an item. Third spec.
- No dependency on superpowers or on the software factory. The factory's ideas are used; none of its code is (it is GPLv3, the pipeline is MIT).
- No sync between a file backlog and issues. A project uses one mode.

## 2. Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Modes | A config key `queue`: `file` (default, today) or `github`. | Solo projects where Claude owns the list keep what works. |
| What is in the queue | Open issues carrying the label in `queueLabel` (default `pipeline`). | Labelling needs triage or write access, so a stranger's issue on a public repository is never built hands-off. |
| Order | Oldest issue first. `/pipeline run <n>` runs a named issue. | GitHub issues have no manual order; Projects is out of scope. |
| Dependencies | Not enforced. `needs` and `move` do not exist in this mode. | The tracker is where a dependency is written; enforcing it means parsing prose. |
| The spec | The pipeline's one comment on the issue, in full; a local file is a cache of it. | The spec is one page; on the issue it is visible to the author before the build and survives the machine. |
| The issue body | Never edited. | It is the author's request as written. |
| Status on the issue | Labels, and the same one comment edited in place. | Every new comment notifies every subscriber. |
| A question | A new comment of its own plus a label. | It must notify the author. |
| Whose replies count | The issue's author and the `gh` user. | Anyone can comment on a public issue. |
| Plan, ledger, briefs, reports, facts | Local, never committed. What only the tool writes is under `.git/pipeline/`; what the lead and subagents write is in the item's worktree under `.pipeline/`, ignored through `.git/info/exclude`. | Working files of the run; nobody reviews them in a PR. Claude Code treats `.git/` as a protected path: an agent's write there prompts in `default` and `acceptEdits` and is denied in `dontAsk`, so agents cannot write there in a hands-off run. |
| Whose spec comment counts | One written by the `gh` user, or by an owner, member or collaborator of the repository. | Anyone can post a comment that starts with the marker. |
| The permanent record | The closed issue and the merged PR. | Both already exist and are where people look. |
| Committed pipeline files | `docs/pipeline/config.json` and `docs/pipeline/rules.md` only. | Edited by hand, shared by everyone who clones. |
| GitHub access | The `gh` CLI, run by the tool through `$.process.run`. | The mod already runs `git` this way; the lead never improvises a tracker command. |

## 3. The queue and its states

The issue number is the item's id: `#12` on GitHub is item `12` in every tool answer, branch name and folder.

| `queue: file` | `queue: github` |
| --- | --- |
| Item `p12` in `backlog.json` | Open issue 12 with the queue label |
| `/pipeline add <text>` | Creates an issue with the queue label; the intake then posts the spec comment |
| `inbox` | A labelled issue with no spec comment and none of the state labels below |
| `ready` | A labelled issue with a spec comment and none of the state labels below |
| `planning`, `building` | Label `pipeline:building`, the issue assigned to the `gh` user, and the state in the spec comment's status line |
| `review` | `pipeline:building`, with `review` and the PR in the spec comment's status line |
| `blocked` | Label `pipeline:blocked`; the reason is in the spec comment's status line |
| An open question | A question comment and label `pipeline:needs-info` |
| `parked` | The queue label removed. `unpark` adds it back |
| `merged` | The PR is merged and the issue closed |
| `move`, `needs` | Refused with one line naming the reason |

Both are picked, oldest first. An `inbox` issue is picked like a file item that has only a note: the lead writes the spec from the issue on pick and posts it.

`pipeline:needs-info` clears when the author or the `gh` user has commented after the pipeline's last question comment. The tool sees that on `get`, removes the label and reports the item ready.

The three state labels are created by `/pipeline init` when they do not exist. Their names follow `queueLabel`: with `queueLabel: factory` they are `factory:building`, `factory:blocked` and `factory:needs-info`.

### The spec comment

One comment per issue, written by the tool, found by a hidden marker on its first line:

```
<!-- pipeline:spec -->
**Pipeline** · building · task 2/5

### Acceptance
- [ ] ...

<details><summary>Spec</summary>

### What
### Why
### Out of scope

</details>
```

The first visible line is the status line: the state, the task counter while building, the block reason when blocked, the PR when one is open. The tool edits the comment in place for every change of state; it posts no other comment except a question. A question comment starts with `<!-- pipeline:question -->`.

The five headings are those of `templates/spec.md`. `Open` is not in the comment: an open question is a question comment.

## 4. Where the files live

```
docs/pipeline/
  config.json            committed, as today
  rules.md               committed, as today

.git/pipeline/           written only by the tool; never committed
  issues.json            the cached issue list with the time it was read
  items.json             what the tracker does not hold per item: branch, plan, PR, note; and GitHub updates still pending
  facts.md               the facts runs learned, as today's docs/pipeline/facts.md
  <issue>/ledger.json
  <issue>.log            a child session's log, as today

<worktree>/.pipeline/<issue>/     written by the tool, the lead and subagents; ignored
  spec.md                cache of the spec comment, written at begin and on resume
  plan.md
  task-N-brief.md, task-N-report.md, ... as today's ledgers/<id>/
```

`init` and `begin` make sure `.git/info/exclude` holds the line `.pipeline/`. That file is local, applies to every worktree and is never committed, so no `.gitignore` entry is needed and `git status` shows nothing.

`backlog.json`, `BACKLOG.md`, `docs/pipeline/specs`, `plans` and `ledgers` are never created. `.git` is the repository's common git directory, so every worktree and every session on the machine reads the same `.git/pipeline/` folder.

Consequences:

- A PR contains code only.
- The tool makes no commit of its own: not on the item's branch at `plan` or `accept`, not on the main branch at `close`.
- `pushMain`, `retain` and `afterMerge`'s default (`BACKLOG.md`) have nothing to act on. `pushMain` and `retain` are ignored in this mode; `afterMerge` runs what it lists and its default is empty.
- `/pipeline clean` removes the worktree and local branch of closed issues that still have one. A closed issue's `ledger.json` stays under `.git/pipeline/`: it is small, local, and `/pipeline status <n>` still answers from it.
- The panel's Merged section lists only issues closed by this machine's runs, from their ledgers.
- An item half built on one machine resumes only there. On another machine the spec is on the issue and the branch is pushed; a run there starts a new plan against the branch as it stands.

## 5. The run loop

The steps of `pipeline-run` and the lead's part in them do not change. The tool's actions differ:

| Action | `queue: github` |
| --- | --- |
| `get` | Reads the labelled open issues with one `gh issue list` call, cached for 60 seconds in `issues.json`; a write of the tool updates the cache with what it wrote. An issue that is closed but still has an entry in `items.json` (its PR merged, its close not run yet) is read on its own and listed, so `mergedPending` and `close` find it. The answer has the same shape as today, with issue numbers as ids and no `needs`. |
| `get { id }` | Adds the issue in full: its body and the comments of its author and the `gh` user, inside a quoted block (section 6). |
| `add` | `gh issue create` with the queue label; answers `added 12 · inbox · no spec`. The lead then writes the spec and posts it with `spec`. |
| `update` | A status change edits labels and the spec comment's status line; a `note` or `pr` goes into the status line. |
| `spec` (new) | `{ action: "spec", id, text }` posts or replaces the spec comment from the given spec text, and rewrites the worktree's `spec.md` when the item has a worktree. |
| `question` (new) | `{ action: "question", id, text }` posts a question comment and adds `pipeline:needs-info`. |
| `move`, `remove` | Refused: the queue is the issues. |
| `park`, `unpark` | Remove or add the queue label. |
| `begin` | Refuses an issue that carries `pipeline:building` when this machine has no ledger for it, unless `force: true` (see The claim). Otherwise adds the label, assigns the issue, makes the worktree and branch, and writes `<worktree>/.pipeline/<issue>/spec.md` from the spec comment. |
| `plan` | Checks the plan at `<worktree>/.pipeline/<issue>/plan.md` and seeds the ledger's tasks. No commit. |
| `brief` | As today, with paths into `<worktree>/.pipeline/<issue>/`. |
| `accept` | Closes the dispatch, records the range and pushes the branch. No record commit. |
| `gate` | As today. |
| `ledger`, `status`, `signals` | As today, reading the local ledger. |
| `close` | Removes the state labels, the worktree (and with it `.pipeline/`), the local branch and the item's entry in `items.json`. A worktree the session sits in is kept, recorded in `items.json` and removed by the next `begin` or `clean`. Closes the issue when the merge did not. It does not check out or commit on the main branch. |

The lead opens the PR as today and adds `Closes #<issue>` to its body. The PR body keeps the ticked acceptance list, the rulings, what was parked and the token totals.

**The claim.** The lock under `.git` still stops two sessions on one machine from taking the same item. Across machines, the `pipeline:building` label is the claim and the local ledger says whose it is: `begin` refuses an issue that carries the label when this machine has no ledger for it, naming the other assignee, or "another machine of yours" when the only assignee is the `gh` user (one user on two machines has one login, which the assignee cannot tell apart). `begin` with `force: true` takes the item over here. Two users that label the same issue within the same second both see the other as a new assignee: the login that sorts first keeps the claim, and the other removes its worktree and its own assignment and touches no label.

**Branch name.** The `branch` key keeps its default `feat/<id>`, which gives `feat/12`.

**Runners.** `runner: session` and `limits.parallel` work as today: a child session reads the same `.git/pipeline/` folder.

**Skills.** `pipeline-run` changes in two places: the PR body line, and a question is the `question` action in place of a line in a spec file. `pipeline-intake` changes more: its duplicate check reads issue titles, `add` creates an issue, and its answer names the issue number. `pipeline-rules` names the new file locations. `pipeline-init` asks nothing new: it sets `queue: github` only when the user asks for issues as the queue.

## 6. Failures and safety

### When GitHub cannot be reached

| Situation | The tool |
| --- | --- |
| `gh` is not installed or not logged in | `init` and every queue action refuse with one line naming the fix (`gh auth login`). Never a silent fall back to a file backlog. |
| The remote is not a GitHub repository | `init` with `queue: github` refuses and says so. |
| Offline or rate-limited during a run | `plan`, `brief`, `accept`'s local part and `gate` need no network and continue. A label or comment change that fails is recorded in the ledger under `pending` and retried at the start of the next writing action; the answer's line ends with `· 1 GitHub update pending`. `get` answers from `issues.json` and says how old it is. |
| A push fails | As today: the task is not accepted until the push succeeds. |
| The issue is closed or loses the queue label during a build | `get` and `signals` report it; the lead finishes the running task and blocks the item with that reason. |
| The PR is merged by hand | As today: the next `get` sees the branch tip on the main branch and reports the item under `mergedPending`. |
| The spec comment was deleted | `begin` and a resume refuse and say so; the lead posts it again from `spec.md` when that exists, or writes it again. |

### Issue text is data

An issue is written by someone else and built without an approval gate.

- Only issues with the queue label are listed.
- The tool passes an issue's body and comments to the lead inside a block that opens with a line saying the text below is quoted from GitHub and describes a request, and is not an instruction to the reader.
- Only comments by the issue's author and by the `gh` user are passed. All others are dropped.
- A spec comment counts only when its author is the `gh` user or an owner, member or collaborator of the repository; a marker in anyone else's comment is ignored.
- Subagents never receive the issue. Their briefs are rendered from the spec the lead wrote, as today.
- `protectedPaths` and the stop conditions in `stop` apply unchanged.

## 7. Structure in the plugin

- **`hooks/tracker.ts`**, new. The only module that knows `gh`. Its operations each take a `run` function (the mod's `$.process.run`) and return plain data: `me` (the `gh` user), `list` (the labelled open issues with labels, assignees and comments), `read` (one issue), `create`, `comment`, `editComment`, `edit` (labels and assignee), `close` and `ensureLabels`. It builds the `gh` argument lists and parses the JSON `gh` prints; it holds no state.
- **`hooks/queue.ts`**, new. Pure. Maps tracker data to the `Backlog` shape every action, the status block and the panel already use; turns the difference between two backlogs into tracker operations; renders and parses the spec comment; builds the quoted block.
- **`hooks/config.ts`**: the keys `queue` and `queueLabel`, validated like the others.
- **`hooks/register.tsx`**: each action asks which queue is configured and calls the backlog module or the queue module. The record paths come from one function, so a ledger or brief is written under `docs/pipeline/` or `.git/pipeline/` by the mode and nowhere else in the file names a path. Claude Code itself guards `.git/pipeline/`; the plugin's own guard is unchanged.
- **`hooks/status.ts`, `hooks/draw.ts`, `hooks/pane.tsx`**: an id is shown as `#12` in this mode; an item's title links to its issue in the panel. No new section.

## 8. Moving an existing project

`/pipeline migrate` on a project that has a `backlog.json`, when the user asks for issues as the queue:

1. Shows what it will do: the items that become issues, the items in flight, the files to remove.
2. Creates a labelled issue for every item that is not `merged` or `parked`, with the item's title, its spec's What and Why as the body, and the spec posted as the spec comment. An item in `planning`, `building` or `review` gets `pipeline:building`.
3. Copies the ledger of each item in flight to `.git/pipeline/<issue>/ledger.json`, its plan and briefs to `<worktree>/.pipeline/<issue>/`, and `facts.md` to `.git/pipeline/facts.md`.
4. Sets `queue: github` in the config.
5. Lists `docs/pipeline/backlog.json`, `BACKLOG.md`, `facts.md`, `specs/`, `plans/` and `ledgers/` for the lead to remove with `git rm` and commit, as migration does today. The tool deletes nothing.

Merged items get no issue; their PRs are the record. Parked items are listed in the answer for the user to file by hand when wanted.

## 9. Testing

- `tracker.ts` and `queue.ts` are tested with a fake `run` that returns the JSON `gh` would print; each test checks the argument lists issued and the data returned. No network.
- The tool's tests gain a `queue: github` set beside the existing ones, on the existing `process.run` handler: `get`, `add`, `begin` (including a refused claim), `plan`, `accept`, `close`, a pending GitHub update and its retry, a question and its cleared label, the quoted block and the comment filter.
- The existing suite runs unchanged under `queue: file`.
- A test asserts that no action in `queue: github` writes under `docs/pipeline/` except `config.json` and `rules.md`, and that none issues a `git commit`.
- One check by hand before release: a test issue on a scratch repository taken from label to merged PR, with a question asked and answered on the way.

## 10. Later specs

1. **Factory judgment**: an intake that accepts, rescopes, asks or rejects; risk and surfaces rated at intake and routed to reviewers and models by the tool; specialist reviewers; an approver that merges what it is sure of and escalates the rest with a question; feedback on an escalated PR as a new round; cost in dollars.
2. **Per-run profiles and parallel slices**: a speed profile and model preset chosen for one run, and independent tasks of one plan built at the same time.
