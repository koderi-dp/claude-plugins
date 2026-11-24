// A run's actions: begin, plan, brief, accept, gate, pr, ship, merge, adopt and close.
import { read } from './state'
import type { Host } from './host'
import type { Backlog, Config, Item, Ledger } from '../types'
import { cleanList } from './clean'
import { DEFAULTS, normalizeConfig } from './config'
import { emptyLedger } from './ledger'
import type { LedgerSet } from './ledger'
import { PRINCIPLES_FILE, acceptanceItems, briefPaths, checkCoverage, checkPlan, commitArgs, parsePlan, renderBrief, riskyMatches, section, splitAttribution, uncovered } from './plan'
import type { Leftover } from './queue'
import { branchOf as itemBranchOf, redOutput, runningOf } from './runner'
import { PLAN_FORMAT } from './templates'
import type { BriefKind } from './templates'
import { ensureWorktree, isChildSession } from './children'
import { claimIssue, editCache, ensureExclude, extrasOrRefuse, ghRun, isGithub, placesOf, readExtras, readIssue, writeExtras } from './github'
import { judgeAll } from './readiness'
import { ACTIVE_STATUSES, children, config, loadBacklog, self, siblings, slashes } from './shared'
import { Refused, checkMerged, cleanInput, listDir, loadLedger, pause, runTool } from './tool'
import type { ToolInput } from './tool'
import { heartbeat, readText } from './watchdog'
import * as tracker from './tracker'

export const BRIEF_KINDS: readonly string[] = ['implementer', 'fix', 'review', 'final']

/** The item's worktree as an absolute path: the ledger's, under the main checkout when relative; the main checkout without one. */
export const worktreePath = (found: string, ledger: Ledger | null): string => {
  const w = typeof ledger?.worktree === 'string' ? slashes(ledger.worktree) : ''
  return !w ? found : /^(?:\/|[A-Za-z]:)/.test(w) ? w : `${found}/${w}`
}

/** A file of the item, read from its worktree first and from the main checkout otherwise. */
export async function readItemFile(h: Host, found: string, wt: string, rel: string): Promise<string | null> {
  return (await readText(h, `${wt}/${rel}`)) ?? (wt === found ? null : await readText(h, `${found}/${rel}`))
}

/** One git answer in the worktree, trimmed; null when git fails. */
export async function gitOut(h: Host, wt: string, args: string[]): Promise<string | null> {
  try {
    const r = await h.process.run(['git', '-C', wt, ...args], { cwd: wt, timeoutMs: 30_000 })
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

/** The spec of an item as a brief and the coverage check read it: the worktree's cache under queue: github, else the item's file. */
export async function readSpec(h: Host, found: string, wt: string, c: Config | null, item: Item | undefined, id: string): Promise<string | null> {
  const P = placesOf(found, c)
  return isGithub(c) ? readText(h, `${wt}/${P.specRel(id)}`) : readItemFile(h, found, wt, item?.spec ?? P.specRel(id))
}

/** The plan of an item, parsed and sound, or refused with the format or the problems. */
export async function loadPlan(h: Host, found: string, wt: string, id: string, ledger: Ledger | null, allowNone = false) {
  const rel = typeof ledger?.plan === 'string' && ledger.plan ? ledger.plan : placesOf(found, await read(h, config)).planRel(id)
  const text = await readItemFile(h, found, wt, rel)
  if (text === null) {
    // Direct mode writes no plan: the one brief it may ask for, the review of the whole branch, needs none.
    if (allowNone && !(ledger?.tasks ?? []).length) return { plan: { title: '', constraints: '', parked: '', tasks: [] }, rel }
    throw new Refused(`no plan at ${rel}; write it in this format, then call plan again:\n\n${PLAN_FORMAT}`)
  }
  const plan = parsePlan(text)
  const problems = checkPlan(plan)
  if (problems.length) throw new Refused(`${rel} cannot be built:\n${problems.map(x => `- ${x}`).join('\n')}\n\nThe format:\n\n${PLAN_FORMAT}`)
  return { plan, rel }
}

/** A brief's answer without its leading item id, for joining onto another answer. */
export const withoutId = (id: string, line: string) => (line.startsWith(`${id} · `) ? line.slice(id.length + 3) : line)

export const FACTS_MAX = 12

/**
 * What a run learned about working in this repository (a command's working spelling, a step that must come first):
 * one line per fact in the facts file of the queue mode, the newest twelve kept, given to every implementer and reviewer.
 */
export async function addFact(h: Host, found: string, fact: string): Promise<void> {
  const line = fact.replace(/\s+/g, ' ').trim().slice(0, 240)
  if (!line) return
  const path = placesOf(found, await read(h, config)).facts
  const lines = ((await readText(h, path)) ?? '').split('\n').map(l => l.replace(/^[-*]\s+/, '').trim()).filter(l => l && !l.startsWith('#'))
  if (lines.some(l => l.toLowerCase() === line.toLowerCase())) return
  const kept = [...lines, line].slice(-FACTS_MAX)
  await h.fs.write(path, `# Facts\n\nWhat runs learned about working in this repository; the tool keeps the newest ${FACTS_MAX} and gives them to every brief. Delete a line that stopped being true.\n\n${kept.map(l => `- ${l}`).join('\n')}\n`)
}

/** Stages the paths and commits them in the worktree with the attribution lines; false when there was nothing to commit or git failed. */
export async function commitPaths(h: Host, wt: string, rels: string[], message: string, attribution: string): Promise<boolean> {
  if ((await gitOut(h, wt, ['add', '--', ...rels])) === null) return false
  return (await gitOut(h, wt, ['commit', '-q', ...commitArgs(message, attribution), '--', ...rels])) !== null
}

/** The lead's model use since the last record, added to the ledger's `lead` and reset. */
export async function recordLead(h: Host, ledger: Ledger | null): Promise<Record<string, unknown>> {
  const before = (ledger?.['lead'] ?? {}) as { tokens?: number; cached?: number }
  const lead = { tokens: (Number(before.tokens) || 0) + self.lead.tokens, cached: (Number(before.cached) || 0) + self.lead.cached }
  self.lead = { tokens: 0, cached: 0 }
  return lead.tokens || lead.cached ? { lead } : {}
}

/**
 * `begin`: the item is this session's. The claim check, the worktree on the item's branch (made here, reused when
 * there), the base, the status and the ledger in one call; the answer names the worktree to enter and what is next.
 */
export async function beginAction(h: Host, found: string, c: Config | null, current: Backlog, id: string, e: ToolInput = { action: 'begin' }): Promise<string> {
  // An item whose pull request was merged by hand is closed here, in code, so the lead spends no call on it.
  try {
    for (const m of await checkMerged(h, found, c, current)) if (m.id !== id) await runTool(h, { action: 'close', item: m.id, ...(m.pr ? { pr: m.pr } : {}) })
  } catch {}
  const item = current.items.find(i => i.id === id)!
  const isChild = await isChildSession(h)
  const isActive = (ACTIVE_STATUSES as readonly string[]).includes(item.status)
  if (!isActive && item.status !== 'ready' && item.status !== 'blocked') {
    const why = item.status === 'inbox' ? (await judgeAll(h, found, current))[id] : undefined
    throw new Refused(`${id} is ${item.status}${why && !why.ready ? `: ${why.reason}` : ''}, not ready`)
  }
  // An item another live session runs is not taken over: two sessions asking for the next item get two items.
  // The live file is read now, under the lock, so a claim made a moment ago by another session is seen.
  if (isActive && self.item !== id && !isChild) {
    await heartbeat(h, true)
    const other = (await read(h, siblings)).find(x => !x.isStale && x.item === id)
    if (other) throw new Refused(`${id} is run by another session (${other.title}); pick the next item`)
    if (runningOf(await read(h, children)).some(ch => ch.item === id)) throw new Refused(`${id} is run by a child session of this one`)
  }
  const mainBranch = c?.mainBranch ?? DEFAULTS.mainBranch
  // What an earlier close had to leave behind (a worktree its session sat in) goes now.
  await sweepMerged(h, found, c, current)
  const ledger = await loadLedger(h, found, id)
  const branch = typeof ledger?.branch === 'string' && ledger.branch ? ledger.branch : itemBranchOf(c?.branch ?? DEFAULTS.branch, id)
  const rel = typeof ledger?.worktree === 'string' && ledger.worktree ? slashes(ledger.worktree) : `.claude/worktrees/${id}`
  const wt = worktreePath(found, { ...(ledger ?? emptyLedger(id)), worktree: rel })
  const P = placesOf(found, c)
  const gh = isGithub(c)
  // queue: github. The issue as GitHub has it now: the claim of another machine and the spec comment, before any worktree.
  let specMd = ''
  let seen: string[] = []
  if (gh) {
    const fresh = await claimIssue(h, found, c, id, ledger !== null, e.force === true)
    specMd = fresh.specMd
    seen = fresh.issue.assignees
  }
  // Off the remote's main when it is known, so the branch starts from what a PR will be compared with.
  await gitOut(h, found, ['fetch', '-q', 'origin', mainBranch])
  const from = (await gitOut(h, found, ['rev-parse', '--verify', '-q', `origin/${mainBranch}`])) !== null ? `origin/${mainBranch}` : mainBranch
  await ensureWorktree(h, found, wt, branch, from)
  if (gh) {
    await ensureExclude(h, found)
    await h.fs.write(`${wt}/${P.specRel(id)}`, specMd)
  }
  const base = ledger?.base ?? (await gitOut(h, wt, ['merge-base', 'HEAD', from])) ?? (await gitOut(h, wt, ['rev-parse', 'HEAD'])) ?? undefined
  const hasTasks = (ledger?.tasks ?? []).length > 0
  // Direct mode has no planning stage: the agent builds the item its own way, so a begun item is building.
  const isDirect = normalizeConfig(c ?? DEFAULTS).config.mode === 'direct' && !hasTasks
  const status = item.status === 'ready' || (item.status === 'blocked' && !hasTasks) ? (isDirect ? 'building' : 'planning') : item.status === 'blocked' ? 'building' : item.status
  self.item = id
  const record = () => runTool(h, { action: 'ledger', item: id, set: { branch, worktree: rel, ...(base ? { base: base.slice(0, 12) } : {}) } })
  if (!gh) await record()
  if (status !== item.status) await runTool(h, { action: 'update', id, set: { status } })
  if (gh) {
    // Two machines that labelled the issue in the same second: of the assignees new since the first read and this
    // user, the login that sorts first keeps the claim. The others let go without touching a label or the status:
    // their worktree, their assignment and their entry in items.json go, and the winner's claim stands.
    if (status !== item.status) {
      const after = await readIssue(h, found, id)
      const rivals = after.assignees.filter(a => a !== self.me && !seen.includes(a))
      const winner = [...rivals, self.me].sort()[0]
      if (rivals.length && winner !== self.me) {
        await gitMain(h, found, ['worktree', 'remove', '--force', wt])
        const off = await tracker.edit(ghRun(h, found), Number(id), { unassign: self.me })
        if (off.ok) await editCache(h, found, issues => issues.map(i => (String(i.number) === id ? { ...i, assignees: i.assignees.filter(a => a !== self.me) } : i)))
        const extras = await extrasOrRefuse(h, found)
        const { [id]: _gone, ...items } = extras.items
        await writeExtras(h, found, { ...extras, items })
        await loadBacklog(h, found)
        if (self.item === id) self.item = ''
        throw new Refused(`${id} is being built by @${winner}; pick the next item`)
      }
    }
    // Recorded once the item is in flight, so its entry in items.json keeps the ledger's link.
    await record()
  }
  await heartbeat(h, true)
  const spec = gh ? P.specRel(id) : item.spec ?? P.specRel(id)
  const r = ledger?.resume
  // Direct mode hands the spec over with the answer, so the lead spends no turn reading it.
  const specBody = isDirect ? ((await readItemFile(h, found, wt, spec)) ?? '').trim() : ''
  const specText = specBody ? `\n\nThe spec (${spec}):\n\n${specBody.length > 6000 ? `${specBody.slice(0, 6000)}\n… (cut: read the file for the rest)` : specBody}` : ` (the spec: ${spec})`
  const next = hasTasks && r ? `resume: task ${r.task}/${ledger!.tasks.length} · ${r.state}${r.lastVerified ? ` · verified ${r.lastVerified}` : ''}` : isDirect ? `next: build it your own way in ${isChild ? 'this directory' : wt}, then ship with "message"${specText}` : `next: in that worktree read ${spec}, write the plan at ${P.planRel(id)}, then plan`
  return `${id} · ${status} · branch ${branch} · base ${(base ?? '?').slice(0, 7)} · ${isChild ? 'this directory is the worktree' : `worktree ${wt}`} · ${next}`
}

/**
 * `accept`: a verified task is recorded and saved in one call. The open dispatch closed, the task accepted with its
 * commit range, the briefs and reports committed, the branch pushed, the resume block moved to the next task.
 */
export async function acceptAction(h: Host, found: string, c: Config | null, id: string, e: ToolInput): Promise<string> {
  const ledger = await loadLedger(h, found, id)
  if (!ledger?.tasks.length) throw new Refused(`${id} has no tasks: call plan first`)
  const n = Number(e.task)
  const task = ledger.tasks.find(t => t.n === n)
  if (!task) throw new Refused(`accept needs task: 1 to ${ledger.tasks.length}`)
  const wt = worktreePath(found, ledger)
  const from = ledger.resume?.lastVerified ?? ledger.base ?? ''
  const head = (await gitOut(h, wt, ['rev-parse', '--short', 'HEAD'])) ?? ''
  if (!head) throw new Refused(`git could not read HEAD in ${wt}`)
  if (from && (await gitOut(h, wt, ['rev-parse', '--short', from])) === head) throw new Refused(`task ${n} has no commit after ${from}: nothing to accept`)
  // The pipeline's own files (a brief rendered again, a report rewritten) are committed below, not the implementer's to commit.
  const P = placesOf(found, c)
  const gh = isGithub(c)
  const dirty = await gitOut(h, wt, ['status', '--porcelain', '--untracked-files=no', '--', '.', `:(exclude)${P.recordsDir}`])
  if (dirty) throw new Refused(`uncommitted changes in the worktree, the implementer did not commit:\n${dirty.split('\n').slice(0, 8).join('\n')}`)
  const wasReviewed = (task.dispatches ?? []).some(d => d.role === 'reviewer')
  // The review the config asks for is checked here, so the lead calls accept straight after its own verification.
  const cfg = normalizeConfig(c ?? DEFAULTS).config
  if (!wasReviewed && cfg.taskReview !== 'off' && from) {
    const names = await gitOut(h, wt, ['diff', '--name-only', `${from}..${head}`])
    const risky = names === null ? [] : riskyMatches(names.split('\n').map(l => l.trim()).filter(Boolean), cfg.riskyPaths)
    if (cfg.taskReview === 'always' || risky.length) {
      throw new Refused(`review first: ${risky.length ? `task ${n} touches ${risky[0]}` : 'taskReview is always'} · brief { kind: "review", task: ${n}, commits: "${from}..${head}", close: { tokens, minutes, result } }, then accept`)
    }
  }
  const attribution = typeof ledger['attribution'] === 'string' ? (ledger['attribution'] as string) : ''
  // queue: github keeps the records out of the repository: nothing to commit.
  const isRecorded = gh ? false : await commitPaths(h, wt, [P.briefDir(id)], `${id}: task ${n} record`, attribution)
  const after = isRecorded ? (await gitOut(h, wt, ['rev-parse', '--short', 'HEAD'])) ?? head : head
  const isPushed = ledger.branch ? (await gitOut(h, wt, ['push', '-q', '-u', 'origin', ledger.branch])) !== null : false
  const next = ledger.tasks.find(t => t.n !== n && t.status !== 'accepted')?.n
  const close = { ...(typeof e.tokens === 'number' ? { tokens: e.tokens } : {}), ...(typeof e.minutes === 'number' ? { minutes: e.minutes } : {}), result: 'done' }
  const carried = typeof e.carried === 'string' && e.carried.trim() ? [e.carried.trim()] : undefined
  const review = { kind: (wasReviewed ? 'independent' : 'lead-diff') as 'independent' | 'lead-diff', verdict: e.verdict?.trim() || 'approved', ...(carried ? { carried } : {}) }
  await runTool(h, { action: 'ledger', item: id, set: { tasks: [{ n, close, status: 'accepted', commits: `${from || 'base'}..${head}`, review }], resume: { task: next ?? n, state: `task ${n} accepted`, lastVerified: after }, ...(await recordLead(h, ledger)) } })
  const done = ledger.tasks.filter(t => t.status === 'accepted' || t.n === n).length
  // The issue's status line shows the task counter.
  if (gh) await runTool(h, { action: 'update', id, set: { note: `task ${done}/${ledger.tasks.length}` } })
  if (typeof e.fact === 'string' && e.fact.trim()) await addFact(h, found, e.fact)
  const line = `${id} · task ${n} accepted · ${done}/${ledger.tasks.length} · ${from ? `${from.slice(0, 7)}..` : ''}${head} · ${isPushed ? 'pushed' : 'not pushed (git push failed: push it yourself)'}`
  // The next Agent call comes with the answer: the next task's implementer, or the final review after the last.
  try {
    const current = (await loadBacklog(h, found)).value
    if (current) return `${line} · ${withoutId(id, await briefAction(h, found, c, current, id, next ? { action: 'brief', kind: 'implementer', task: next, ...(carried ? { carried: carried[0]! } : {}) } : { action: 'brief', kind: 'final' }))}`
  } catch {}
  return `${line} · next: ${next ? `brief task ${next}` : ledger.final ? 'ship with the final verdict (brief final with findings for another review)' : 'brief final'}`
}

/**
 * A command run to its end with no time limit of the host's (a gate may take longer than the ten minutes one
 * `process.run` gets): the exit code and the last of its output. Null code when it was killed by a signal.
 */
/**
 * A shell command line run to its end through `runLong`. `sh` first; where there is no `sh` on PATH (Windows outside
 * Git Bash) the `sh.exe` that ships with Git, found from `git --exec-path`. Throws the first error when neither starts.
 */
export async function runShell(h: Host, command: string, cwd: string): Promise<{ code: number | null; out: string }> {
  try {
    return await runLong(h, ['sh', '-c', command], cwd)
  } catch (err) {
    // <Git>/mingw64/libexec/git-core (or ucrt64, clangarm64, usr) → <Git>/bin/sh.exe, else <Git>/usr/bin/sh.exe
    const exec = slashes((await gitOut(h, cwd, ['--exec-path'])) ?? '')
    const root = /^(.*)\/[^/]+\/(?:libexec|lib)\/git-core\/?$/.exec(exec)?.[1]
    if (!root) throw err
    for (const sh of [`${root}/bin/sh.exe`, `${root}/usr/bin/sh.exe`]) {
      try {
        return await runLong(h, [sh, '-c', command], cwd)
      } catch {
        // try the next one
      }
    }
    throw err
  }
}

export async function runLong(h: Host, argv: string[], cwd: string): Promise<{ code: number | null; out: string }> {
  const stream = h.process.spawn({ argv, cwd })
  let out = ''
  for (;;) {
    const r = await stream.next()
    if (r.done) return { code: r.value?.code ?? null, out }
    out = (out + r.value.text).slice(-400_000)
  }
}

/**
 * `merge`: the end of an item whose PR is open, in one call. The tool polls the PR's checks over the REST API until
 * they are through (an hour at most), merges with the configured method through `gh api`, then closes the item. Red
 * checks answer their names and nothing is merged. Not under the lock while it waits: CI may take longer than another
 * session should wait for it.
 */
export async function mergeAction(h: Host, found: string, c: Config | null, current: Backlog, id: string, e: ToolInput): Promise<string> {
  const cfg = normalizeConfig(c ?? DEFAULTS).config
  const item = current.items.find(i => i.id === id)!
  const ledger = await loadLedger(h, found, id)
  const pr = e.pr?.trim() || item.pr || ledger?.pr || ''
  const n = Number(/(\d+)\/?$/.exec(pr)?.[1])
  if (!n) throw new Refused(`merge needs the pull request: pass "pr": "#31" (${id} carries none)`)
  const yourself = `merge pull request #${n} yourself, then close`
  // A pull request the item did not open itself (a follow-up branch, a PR made by hand): its head is the item's
  // branch from here on, so close looks for the right one.
  if (!(typeof ledger?.branch === 'string' && ledger.branch) && !item.branch) {
    const info = await tracker.prInfo(ghRun(h, found), n)
    if (info.ok && info.value.head) await runTool(h, { action: 'ledger', item: id, set: { branch: info.value.head, pr: `#${n}` } })
  }
  // A real wait between polls: `sleep` as a process, so it does not hang on a clock that only a test moves; the clock where there is no sleep.
  const wait = async (ms: number): Promise<void> => {
    try {
      const r = await h.process.run(['sleep', String(Math.ceil(ms / 1000))], { cwd: found, timeoutMs: ms + 10_000 })
      if (r.exitCode === 0) return
    } catch {
      // no sleep on this machine
    }
    await pause(h, ms)
  }
  const run = ghRun(h, found)
  // A repository with workflow files is expected to report: no check within five minutes is then not "no CI",
  // and the pull request is not merged on it (unless forced).
  const wtOf = worktreePath(found, ledger)
  const flows = [...(await listDir(h, `${wtOf}/.github/workflows`)), ...(wtOf === found ? [] : await listDir(h, `${found}/.github/workflows`))]
  const expectsCi = flows.some(f => /\.ya?ml$/i.test(f))
  const state = await tracker.watchChecks(run, n, wait, expectsCi)
  if (!state.ok) throw new Refused(`${state.error} · or ${yourself}`)
  if (state.value.state === 'none' && expectsCi && !e.force && !state.value.quiet) return `${id} · CI has not reported on PR #${n} after five minutes although the repository has workflows · not merged · look at the Actions tab, then merge again, or merge with "force": true`
  if (state.value.state === 'red') return `${id} · CI red · ${state.value.failing.join(', ')} · PR #${n} not merged · one fix wave, then merge again`
  if (state.value.state === 'pending') return `${id} · CI still running on PR #${n} · merge again`
  const merged = await tracker.mergePr(run, n, cfg.mergeMethod)
  if (!merged.ok) throw new Refused(`PR #${n} could not be merged: ${merged.error}`)
  // A squash leaves the branch tip off mainBranch, so close is told the merge happened.
  const closed = await runTool(h, { action: 'close', item: id, pr: pr.startsWith('#') || /^https?:/.test(pr) ? pr : `#${n}`, ...(cfg.mergeMethod === 'squash' || e.force ? { force: true } : {}) })
  return `${closed} · CI ${state.value.state !== 'none' ? 'green' : state.value.quiet ? 'none (no workflow ran for this commit)' : 'none'}`
}

/**
 * `gate`: the tool runs `checks.gate` in the worktree itself and records what happened with the final verdict, so
 * a gate is never green by assumption. Green: the records committed and the branch pushed. Red: the output's tail.
 */
export async function gateAction(h: Host, found: string, c: Config | null, id: string, e: ToolInput): Promise<string> {
  const ledger = await loadLedger(h, found, id)
  if (!ledger) throw new Refused(`${id} has no ledger`)
  const wt = worktreePath(found, ledger)
  const cfg = normalizeConfig(c ?? DEFAULTS).config
  const command = cfg.checks.gate?.trim()
  // Direct mode: there are no tasks, so the gate is where the work is checked in. What `accept` asks of a task
  // is asked here of the whole branch: committed, something built, and reviewed first when it touches a risky path.
  const isDirect = !ledger.tasks.length
  let range = ''
  let verified = ledger.resume?.lastVerified ?? ''
  if (isDirect) {
    const base = ledger.base ?? ''
    const head = (await gitOut(h, wt, ['rev-parse', '--short', 'HEAD'])) ?? ''
    if (base && head && (await gitOut(h, wt, ['rev-parse', '--short', base])) === head) throw new Refused(`${id} has no commit after ${base.slice(0, 7)}: build it and commit, then gate`)
    const dirty = await gitOut(h, wt, ['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude)docs/pipeline', ':(exclude).pipeline'])
    if (dirty) throw new Refused(`uncommitted changes in the worktree: commit them, then gate\n${dirty.split('\n').slice(0, 8).join('\n')}`)
    range = base && head ? `${base.slice(0, 7)}..${head}` : ''
    if (head) verified = head
    const reviewed = Boolean(e.verdict?.trim() || ledger.final?.verdict)
    if (!reviewed && cfg.taskReview !== 'off' && range) {
      const names = await gitOut(h, wt, ['diff', '--name-only', `${base}..${head}`])
      const risky = names === null ? [] : riskyMatches(names.split('\n').map(l => l.trim()).filter(Boolean), cfg.riskyPaths)
      if (cfg.taskReview === 'always' || risky.length) {
        throw new Refused(`review first: ${risky.length ? `the branch touches ${risky[0]}` : 'taskReview is always'} · brief { item: "${id}", kind: "final" }, the Agent call it answers, then gate with "verdict"`)
      }
    }
    await runTool(h, { action: 'ledger', item: id, set: { resume: { task: 1, state: 'gate running', ...(head ? { lastVerified: head } : {}) } } })
  }
  let gate = 'none configured'
  let output = ''
  if (command) {
    try {
      const r = await runShell(h, command, wt)
      gate = r.code === 0 ? 'green' : `red (exit ${r.code ?? 'signal'})`
      if (r.code !== 0) output = redOutput(r.out.trim(), 20)
    } catch (err) {
      throw new Refused(`the gate could not be run here (${err instanceof Error ? err.message : String(err)}): run \`${command}\` yourself and record it with ledger { final: { verdict, gate } }`)
    }
  }
  const verdict = e.verdict?.trim() || ledger.final?.verdict || (isDirect ? 'no review asked' : 'not reviewed')
  const final = { ...(ledger.final ?? {}), verdict, gate, ...(range ? { commits: range } : {}), ...(typeof e.tokens === 'number' ? { tokens: e.tokens } : {}) }
  await runTool(h, { action: 'ledger', item: id, set: { final, resume: { task: isDirect ? 1 : (ledger.resume?.task ?? ledger.tasks.length), state: gate.startsWith('red') ? 'gate red' : 'gate run', ...(verified ? { lastVerified: verified } : {}) }, ...(await recordLead(h, ledger)) } })
  if (gate.startsWith('red')) return `${id} · gate ${gate} · \`${command}\`\n${output}`
  const attribution = typeof ledger['attribution'] === 'string' ? (ledger['attribution'] as string) : ''
  if (!isGithub(c)) await commitPaths(h, wt, [placesOf(found, c).briefDir(id)], `${id}: final review record`, attribution)
  const isPushed = ledger.branch ? (await gitOut(h, wt, ['push', '-q', '-u', 'origin', ledger.branch])) !== null : false
  return `${id} · gate ${gate} · final ${verdict} · ${isPushed ? 'pushed' : 'not pushed (git push failed: push it yourself)'} · next: ${isDirect || /approved/i.test(verdict) ? `ship { item: "${id}" }` : 'the final review'}`
}

/**
 * `ship`: everything after the building, in one call. What is uncommitted is committed with the message, the gate
 * is run, the pull request opened and, under `merge: auto`, CI waited for, the PR merged and the item closed. It
 * stops at the first thing the lead must act on (a red gate, a review to dispatch, red CI) and says what. On the
 * full loop it is the same end once every task is accepted: the gate with the final verdict, then the rest.
 */
export async function shipAction(h: Host, found: string, c: Config | null, current: Backlog, id: string, e: ToolInput): Promise<string> {
  const cfg = normalizeConfig(c ?? DEFAULTS).config
  let ledger = await loadLedger(h, found, id)
  if (!ledger?.branch) throw new Refused(`${id} has no branch on record: begin it first`)
  // The full loop: the tasks are the implementers' commits, so nothing is committed here; ship is the gate with
  // the final verdict (unless it already ran green), the pull request and the merge.
  const isFull = ledger.tasks.length > 0
  // A fix after the final review reopens a task that was accepted before. The approving verdict of the re-review
  // is its acceptance too, so ship accepts it here; a task never accepted stays the lead's to accept.
  const isReopened = (t: Ledger['tasks'][number]) => t.status === 'fix' && Boolean(t.review)
  if (/approved/i.test(e.verdict ?? '') && ledger.tasks.some(isReopened) && ledger.tasks.every(t => t.status === 'accepted' || isReopened(t))) {
    for (const t of ledger.tasks.filter(isReopened)) {
      const said = await runTool(h, { action: 'accept', item: id, task: t.n, verdict: e.verdict! })
      if (said.startsWith('refused')) throw new Refused(said.replace(/^refused:\s*/, ''))
    }
    ledger = (await loadLedger(h, found, id)) ?? ledger
  }
  const open = ledger.tasks.find(t => t.status !== 'accepted')
  if (open) throw new Refused(`${id} runs on the full loop and task ${open.n} is not accepted: accept its tasks, then ship with the final verdict`)
  const isGated = isFull && ledger.final?.gate === 'green' && /approved/i.test(ledger.final?.verdict ?? '') && !e.verdict
  const wt = worktreePath(found, ledger)
  if (typeof e.attribution === 'string') await runTool(h, { action: 'ledger', item: id, set: { attribution: e.attribution } })
  const attribution = typeof e.attribution === 'string' ? e.attribution : typeof ledger['attribution'] === 'string' ? (ledger['attribution'] as string) : ''
  const SCOPE = ['--', '.', ':(exclude)docs/pipeline', ':(exclude).pipeline']
  const dirty = isFull ? '' : await gitOut(h, wt, ['status', '--porcelain', ...SCOPE])
  if (dirty) {
    if (!e.message?.trim()) throw new Refused('uncommitted changes in the worktree: pass "message" and ship commits them')
    await gitOut(h, wt, ['add', '-A', ...SCOPE])
    const done = await gitOut(h, wt, ['commit', '-q', ...commitArgs(e.message, attribution)])
    if (done === null) throw new Refused('git commit failed in the worktree: commit it yourself, then ship')
  }
  // The gate, with the review a risky branch needs answered as the call to make.
  let gated = `${id} · gate green`
  if (!isGated) try {
    gated = await runTool(h, { action: 'gate', item: id, ...(e.verdict ? { verdict: e.verdict } : {}), ...(typeof e.tokens === 'number' ? { tokens: e.tokens } : {}) })
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err)
    if (!said.startsWith('review first')) throw err
    const after = (await loadBacklog(h, found)).value ?? current
    const brief = await briefAction(h, found, c, after, id, { action: 'brief', kind: 'final' })
    return `${id} · ${said.split(' · ')[0]} · ${withoutId(id, brief)} Then ship again with "verdict".`
  }
  if (/· gate red/.test(gated.split('\n')[0] ?? '')) return gated
  // A full-loop gate without an approved final review stops here: the review comes first.
  if (isFull && / · next: the final review$/.test(gated.split('\n')[0] ?? '')) return gated
  // The pull request; without gh the branch is pushed and the rest is the lead's.
  let opened: string
  try {
    opened = await runTool(h, { action: 'pr', item: id, ...(e.title ? { title: e.title } : {}), ...(e.body ? { body: e.body } : {}) })
  } catch (err) {
    return `${gated.replace(/ · next: .*$/, '')} · PR not opened (${err instanceof Error ? err.message.split(' · ')[0] : String(err)}): open it yourself, then update with "pr" and "status": "review"`
  }
  let out = opened
  if (cfg.merge === 'auto') out = await runTool(h, { action: 'merge', item: id })
  // Under run all, the next item is begun with the same answer.
  if (e.next && (cfg.merge !== 'auto' || / merged/.test(out))) {
    try {
      out = `${out}\n\nNext item:\n${await runTool(h, { action: 'begin' })}`
    } catch (err) {
      out = `${out} · ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return out
}

/**
 * `pr`: opens the item's pull request through gh and records it, in one call. The title is the item's, the body
 * the spec's What and Acceptance unless one is given. Under `merge: pr` the item waits in review for the user.
 */
export async function prAction(h: Host, found: string, c: Config | null, current: Backlog, id: string, e: ToolInput): Promise<string> {
  const cfg = normalizeConfig(c ?? DEFAULTS).config
  const item = current.items.find(i => i.id === id)!
  const ledger = await loadLedger(h, found, id)
  if (!ledger?.branch) throw new Refused(`${id} has no branch on record: begin it first`)
  if (item.pr || ledger.pr) return `${id} · PR ${item.pr ?? ledger.pr} is already open · next: ${cfg.merge === 'auto' ? 'merge' : 'the user merges it'}`
  const wt = worktreePath(found, ledger)
  const P = placesOf(found, c)
  const spec = (await readItemFile(h, found, wt, isGithub(c) ? P.specRel(id) : item.spec ?? P.specRel(id))) ?? ''
  const acceptance = section(spec, 'Acceptance')
  const what = section(spec, 'What')
  // Of the attribution lines, the git trailers belong to commits; the rest ends the pull request's text.
  const attribution = splitAttribution(typeof ledger['attribution'] === 'string' ? (ledger['attribution'] as string) : '').rest.join('\n')
  const body = typeof e.body === 'string' && e.body.trim() ? e.body.trim() : [what, acceptance ? `## Acceptance\n\n${acceptance}` : '', isGithub(c) ? `Closes #${id}` : '', attribution].filter(Boolean).join('\n\n')
  const title = typeof e.title === 'string' && e.title.trim() ? e.title.trim() : isGithub(c) ? item.title : `${id}: ${item.title}`
  const made = await tracker.createPr(ghRun(h, found), { base: cfg.mainBranch, head: ledger.branch, title, body })
  if (!made.ok) throw new Refused(`${made.error} · or open the pull request yourself, then update with "pr"`)
  const pr = `#${made.value}`
  await runTool(h, { action: 'ledger', item: id, set: { pr } })
  await runTool(h, { action: 'update', id, set: { status: 'review', pr } })
  return `${id} review · PR ${pr} · next: ${cfg.merge === 'auto' ? `merge { item: "${id}" }` : 'the user merges it; close runs on a later get'}`
}

/** Whether a pull request's text already closes the issue on merge, in one of the words GitHub reads. */
export const closesIssue = (body: string, id: string): boolean => new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${id}\\b`, 'i').test(body)

/**
 * `adopt`: a pull request that was opened with no item becomes one. The item is made from the pull request's title
 * and text (with queue: github a labelled issue), the branch and the pull request go on its record, and it is set
 * to review, so `merge` or a merge by hand ends it like any other item. With queue: github the pull request's text
 * gets `Closes #<issue>` when it does not say so yet. Refused for a pull request that is merged or closed, or that
 * an item already carries.
 */
export async function adoptAction(h: Host, found: string, c: Config | null, current: Backlog, e: ToolInput): Promise<string> {
  const cfg = normalizeConfig(c ?? DEFAULTS).config
  const n = Number(/(\d+)\/?$/.exec(e.pr?.trim() ?? '')?.[1])
  if (!n) throw new Refused('adopt needs "pr": the pull request, as #114')
  const pr = `#${n}`
  const run = ghRun(h, found)
  const got = await tracker.prDetail(run, n)
  if (!got.ok) throw new Refused(got.error)
  const { title, body, head, state } = got.value
  if (state !== 'open') throw new Refused(`PR ${pr} is ${state}: only an open pull request is adopted`)
  if (!head) throw new Refused(`PR ${pr} has no head branch to record`)
  const has = current.items.find(i => i.status !== 'merged' && (new RegExp(`(?:^|[#/])${n}/?$`).test(i.pr ?? '') || i.branch === head))
  if (has) throw new Refused(`PR ${pr} already belongs to ${has.id} (${has.status})`)
  const note = `adopted from PR ${pr}`
  const text = body.trim()
  const added = await runTool(h, { action: 'add', item: { title: title || `Pull request ${pr}`, note: isGithub(c) ? [text, `Adopted from pull request ${pr}.`].filter(Boolean).join('\n\n') : note } })
  const id = /^added (\S+)/.exec(added)?.[1]
  if (!id) throw new Refused(`the item for PR ${pr} could not be made: ${added}`)
  await runTool(h, { action: 'ledger', item: id, set: { branch: head, pr } })
  await runTool(h, { action: 'update', id, set: { status: 'review', pr, branch: head, note } })
  let linked = ''
  if (isGithub(c) && !closesIssue(body, id)) {
    const set = await tracker.setPrBody(run, n, [text, `Closes #${id}`].filter(Boolean).join('\n\n'))
    linked = set.ok ? ` · PR says Closes #${id}` : ` · add "Closes #${id}" to the PR yourself (${set.error})`
  }
  return `adopted PR ${pr} as ${id} · review · branch ${head}${linked} · next: ${cfg.merge === 'auto' ? `merge { item: "${id}" }` : 'the user merges it; close runs on a later get'}`
}

/** One git answer in the main checkout: the exit code and the first line of what it said. */
export async function gitMain(h: Host, found: string, args: string[]): Promise<{ ok: boolean; said: string }> {
  try {
    const r = await h.process.run(['git', '-C', found, ...args], { cwd: found, timeoutMs: 120_000 })
    return { ok: r.exitCode === 0, said: (r.stderr || r.stdout).trim().split('\n')[0] ?? '' }
  } catch (err) {
    return { ok: false, said: err instanceof Error ? err.message : String(err) }
  }
}

/** Whether this session's working directory is inside the folder. */
export async function isInside(h: Host, dir: string): Promise<boolean> {
  try {
    const cwd = `${slashes(await h.session.cwd())}/`
    return cwd.startsWith(`${slashes(dir)}/`)
  } catch {
    return false
  }
}

/**
 * Removes what `cleanList` names for the merged items it is given, from the main checkout: tracked paths with
 * `git rm`, untracked ones with `git clean`, a worktree with `git worktree remove`, a `branch:` line with
 * `git branch -D`. A worktree this session is inside is left, and named in `kept`.
 */
export async function removeCleaned(h: Host, found: string, list: string[]): Promise<{ removed: number; kept: string[]; paths: string[] }> {
  let removed = 0
  const kept: string[] = []
  const paths: string[] = []
  for (const entry of list) {
    if (entry.startsWith('branch:')) {
      // A branch still checked out in a kept worktree cannot go; it goes with the worktree later.
      if ((await gitMain(h, found, ['branch', '-D', entry.slice('branch:'.length)])).ok) removed++
      continue
    }
    const rel = entry.replace(/\/+$/, '')
    if (rel.startsWith('.claude/worktrees/')) {
      if (await isInside(h, `${found}/${rel}`)) {
        kept.push(rel)
        continue
      }
      if ((await gitMain(h, found, ['worktree', 'remove', '--force', rel])).ok) removed++
      continue
    }
    const tracked = await gitMain(h, found, ['rm', '-r', '-q', '--ignore-unmatch', '--', rel])
    await gitMain(h, found, ['clean', '-fdq', '--', rel])
    if (tracked.ok) {
      removed++
      paths.push(rel)
    }
  }
  return { removed, kept, paths }
}

/** The worktrees and local branches of items already merged, removed when this session is not inside them: what an earlier close had to leave. */
export async function sweepMerged(h: Host, found: string, c: Config | null, b: Backlog): Promise<void> {
  try {
    const list = cleanList({ config: c, backlog: b, ...(isGithub(c) ? { queue: 'github' as const } : {}), ...(await cleanInput(h, found, b)) }).filter(x => x.startsWith('branch:') || x.startsWith('.claude/worktrees/'))
    // Worktrees first, so their branches are free to delete.
    await removeCleaned(h, found, [...list.filter(x => !x.startsWith('branch:')), ...list.filter(x => x.startsWith('branch:'))])
  } catch {}
  if (isGithub(c)) await sweepLeftover(h, found)
}

/**
 * queue: github. A closed issue is not in the backlog, so the worktree a close had to leave is kept in items.json:
 * each one this session is not inside is removed, then its branch, and its entry dropped.
 */
export async function sweepLeftover(h: Host, found: string): Promise<void> {
  try {
    const extras = await extrasOrRefuse(h, found)
    const left = extras.leftover ?? []
    if (!left.length) return
    const kept: Leftover[] = []
    for (const l of left) {
      const dir = worktreePath(found, { ...emptyLedger(l.id), worktree: l.worktree })
      if (await isInside(h, dir)) {
        kept.push(l)
        continue
      }
      await gitMain(h, found, ['worktree', 'remove', '--force', l.worktree])
      if (l.branch) await gitMain(h, found, ['branch', '-D', l.branch])
    }
    const { leftover: _was, ...rest } = extras
    await writeExtras(h, found, { ...rest, ...(kept.length ? { leftover: kept } : {}) })
  } catch {}
}

/** queue: github: the worktrees and branches a close had to leave, as `clean` lists them; for one item when `id` is given. */
export async function leftoverLines(h: Host, found: string, id: string | undefined): Promise<string[]> {
  const ex = await readExtras(h, found)
  return (ex.value?.leftover ?? []).filter(l => id === undefined || l.id === id).flatMap(l => [l.worktree.replace(/\/+$/, ''), ...(l.branch ? [`branch:${l.branch}`] : [])])
}

/**
 * `close`: the whole Close in one call, run by the tool in the main checkout, so it works from a session that
 * sits in the item's worktree and cannot leave it. Refused when the pull request is not on mainBranch yet.
 */
export async function closeAction(h: Host, found: string, c: Config | null, current: Backlog, id: string, e: ToolInput): Promise<string> {
  const cfg = normalizeConfig(c ?? DEFAULTS).config
  const item = current.items.find(i => i.id === id)!
  const ledger = await loadLedger(h, found, id)
  const branch = (typeof ledger?.branch === 'string' && ledger.branch) || item.branch || itemBranchOf(cfg.branch, id)
  const main = cfg.mainBranch
  const pr = e.pr?.trim() || item.pr || ledger?.pr || undefined
  const gh = isGithub(c)

  if (gh) {
    // queue: github has no record to commit on mainBranch: the main checkout is left as it is, origin/<main> is enough.
    await gitMain(h, found, ['fetch', '-q', 'origin', main])
  } else {
    // The main checkout on mainBranch, with the merge in it.
    const on = await gitOut(h, found, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (on !== main) {
      const co = await gitMain(h, found, ['checkout', main])
      if (!co.ok) throw new Refused(`the main checkout is on ${on ?? 'an unknown branch'} and git checkout ${main} failed: ${co.said}`)
    }
    await gitMain(h, found, ['fetch', '-q', 'origin', main])
    const pull = await gitMain(h, found, ['merge', '--ff-only', `origin/${main}`])
    if (!pull.ok) throw new Refused(`${main} in the main checkout could not be fast-forwarded to origin/${main}: ${pull.said}`)
  }
  if (item.status !== 'merged' && !e.force) {
    const tip = (await gitOut(h, found, ['rev-parse', '--verify', '-q', branch])) ?? (await gitOut(h, found, ['rev-parse', '--verify', '-q', `origin/${branch}`]))
    let isIn = tip !== null && (await gitMain(h, found, ['merge-base', '--is-ancestor', tip, `origin/${main}`])).ok
    // GitHub saying the pull request is merged settles it, also after a squash and for a branch of another name.
    const prN = Number(/(\d+)\/?$/.exec(pr ?? '')?.[1])
    if (!isIn && prN) {
      const there = await tracker.prInfo(ghRun(h, found), prN)
      isIn = there.ok && there.value.merged
    }
    if (!isIn) throw new Refused(`${branch} is not on origin/${main}: the pull request is not merged yet; after a squash merge pass "force": true`)
  }

  const closed = async () => {
    if (ledger) await runTool(h, { action: 'ledger', item: id, set: { resume: { task: ledger.resume?.task ?? ledger.tasks.length, state: 'closed', ...(ledger.resume?.lastVerified ? { lastVerified: ledger.resume.lastVerified } : {}) }, ...(await recordLead(h, ledger)) } })
  }
  // queue: github: a merged issue leaves the backlog, so its ledger is closed while the item is still there.
  if (gh) await closed()
  // Merged in the backlog (with queue: github the labels off and the issue closed), then what retain lets go.
  if (item.status !== 'merged' || (pr && item.pr !== pr)) await runTool(h, { action: 'update', id, set: { status: 'merged', ...(pr ? { pr } : {}) } })
  const after = (await loadBacklog(h, found)).value ?? current
  const merged = after.items.some(i => i.id === id) ? after : { ...after, items: [...after.items, { ...item, status: 'merged' as const, ...(pr ? { pr } : {}) }] }
  const list = cleanList({ config: c, backlog: merged, item: id, ...(gh ? { queue: 'github' as const } : {}), ...(await cleanInput(h, found, merged)) })
  const { kept, paths: gone } = await removeCleaned(h, found, [...list.filter(x => !x.startsWith('branch:')), ...list.filter(x => x.startsWith('branch:'))])
  if (!gh) await closed()
  if (gh) {
    if (kept.length) {
      const extras = await extrasOrRefuse(h, found)
      const leftover = [...(extras.leftover ?? []).filter(l => l.id !== id), { id, worktree: kept[0]!, branch }]
      await writeExtras(h, found, { ...extras, leftover })
    }
    if (self.item === id) self.item = ''
    const tasks = ledger?.tasks.length ?? 0
    const next = after.items.find(i => i.status === 'ready')
    const left = kept.length ? ` · worktree ${kept[0]} left because this session's shell is in it: nothing to do, the next begin or /pipeline clean removes it` : ''
    return `${id} merged${pr ? ` · PR ${pr}` : ''} · ${tasks} task${tasks === 1 ? '' : 's'} · issue closed${left} · next: ${next ? next.id : 'nothing ready'}`
  }

  // The record on mainBranch.
  const attribution = typeof ledger?.['attribution'] === 'string' ? (ledger['attribution'] as string) : ''
  await gitMain(h, found, ['add', '-A', '--', 'docs/pipeline'])
  const commit = await gitMain(h, found, ['commit', '-q', ...commitArgs(`${id}: close records`, attribution), '--', 'docs/pipeline', ...gone.filter(x => !x.startsWith('docs/pipeline/'))])
  const pushed = cfg.pushMain === false ? 'not pushed (pushMain is off)' : (await gitMain(h, found, ['push', '-q', 'origin', main])).ok ? 'pushed' : 'not pushed (git push failed: push it yourself)'
  if (self.item === id) self.item = ''
  const tasks = ledger?.tasks.length ?? 0
  const next = after.items.find(i => i.status === 'ready')
  const left = kept.length ? ` · worktree ${kept[0]} left because this session's shell is in it: nothing to do, the next begin or /pipeline clean removes it` : ''
  return `${id} merged${pr ? ` · PR ${pr}` : ''} · ${tasks} task${tasks === 1 ? '' : 's'} · records ${commit.ok ? 'committed' : 'unchanged'} on ${main} · ${pushed}${left} · next: ${next ? next.id : 'nothing ready'}`
}

/** `plan`: the checked plan becomes the ledger's tasks and resume block, and the item is building. */
export async function planAction(h: Host, found: string, c: Config | null, current: Backlog, id: string, e: ToolInput): Promise<string> {
  const ledger = await loadLedger(h, found, id)
  const wt = worktreePath(found, ledger)
  const { plan, rel } = await loadPlan(h, found, wt, id, ledger)
  const known = new Map((ledger?.tasks ?? []).map(t => [t.n, t]))
  // Every acceptance item of the spec has a task or is parked on purpose. A fresh plan that leaves one out is
  // refused, when adding a task costs nothing; a plan already being built is only told.
  const accepted = acceptanceItems((await readSpec(h, found, wt, c, current.items.find(i => i.id === id), id)) ?? '')
  const gaps = checkCoverage(plan, accepted)
  if (gaps.length && !known.size) {
    const open = uncovered(plan, accepted)
    throw new Refused(`${rel} leaves acceptance uncovered:\n${gaps.map(x => `- ${x}`).join('\n')}${open.length ? `\n\nadd \`- Covers: <numbers>\` to the task that delivers it, or name it under \`## Parked\` as \`Acceptance ${open[0]}\` with the reason` : ''}`)
  }
  const open = uncovered(plan, accepted)
  const note = open.length ? ` · note: acceptance ${open.join(', ')} covered by no task` : ''
  const tasks = plan.tasks.map(t => (known.has(t.n) ? { n: t.n, title: t.title } : { n: t.n, title: t.title, status: 'pending' as const, dispatches: [] }))
  const next = plan.tasks.find(t => known.get(t.n)?.status !== 'accepted')?.n ?? plan.tasks.length
  const lastVerified = ledger?.resume?.lastVerified ?? ledger?.base ?? (await gitOut(h, wt, ['rev-parse', '--short', 'HEAD'])) ?? undefined
  const set: LedgerSet = { plan: rel, tasks, resume: { task: next, state: known.size ? ledger?.resume?.state ?? 'planned' : 'planned', ...(lastVerified ? { lastVerified } : {}) } }
  if (typeof e.attribution === 'string') set['attribution'] = e.attribution
  await runTool(h, { action: 'ledger', item: id, set })
  const item = current.items.find(i => i.id === id)!
  if (item.status !== 'building') await runTool(h, { action: 'update', id, set: { status: 'building' } })
  // The plan is committed here, so the lead spends no turn on it; nothing to commit is fine. queue: github commits no record.
  const attribution = typeof e.attribution === 'string' ? e.attribution : typeof ledger?.['attribution'] === 'string' ? (ledger['attribution'] as string) : ''
  const committed = isGithub(c) ? false : await commitPaths(h, wt, [rel], `${id}: plan`, attribution)
  const head = `${id} · building · ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}${committed ? ' · plan committed' : ''}`
  // A fresh plan answers the first Agent call too, so the lead spends no turn asking for it.
  if (!known.size) {
    try {
      const after = (await loadBacklog(h, found)).value ?? current
      return `${head} · ${withoutId(id, await briefAction(h, found, c, after, id, { action: 'brief', kind: 'implementer', task: next }))}`
    } catch {}
  }
  return `${head} · next: brief task ${next}${note}`
}

/** `brief`: one brief rendered into the worktree, its dispatch opened in the ledger, and the Agent call in one line. */
export async function briefAction(h: Host, found: string, c: Config | null, current: Backlog, id: string, e: ToolInput): Promise<string> {
  const kind = e.kind as BriefKind
  if (!BRIEF_KINDS.includes(String(e.kind))) throw new Refused('brief needs kind: implementer, fix, review or final')
  const cfg = normalizeConfig(c ?? DEFAULTS).config
  const ledger = (await loadLedger(h, found, id)) ?? emptyLedger(id)
  const wt = worktreePath(found, ledger)
  const { plan } = await loadPlan(h, found, wt, id, ledger, kind === 'final')
  const n = kind === 'final' ? plan.tasks.length : Number(e.task)
  if (kind !== 'final' && !plan.tasks.some(t => t.n === n)) throw new Refused(`brief needs task: 1 to ${plan.tasks.length}`)
  const P = placesOf(found, c)
  const dir = P.briefDir(id)

  // A review the config does not ask for is answered, not rendered; a re-review (findings given) always runs.
  let risky: string[] = []
  if (kind === 'review') {
    if (!e.commits?.trim()) throw new Refused('a review brief needs commits, as <sha>..<sha>')
    if (!e.findings?.trim()) {
      if (cfg.taskReview === 'off') return `no review: taskReview off · accept task ${n} with review.kind lead-diff`
      const names = await gitOut(h, wt, ['diff', '--name-only', e.commits.trim()])
      risky = names === null ? [] : riskyMatches(names.split('\n').map(l => l.trim()).filter(Boolean), cfg.riskyPaths)
      if (cfg.taskReview === 'risky' && names !== null && !risky.length) return `no review: ${e.commits.trim()} touches no risky path · accept task ${n} with review.kind lead-diff`
    }
  }

  // The round is the first whose brief is not on disk yet: fix rounds from 1, a re-review and a second final review from 2.
  let round = 1
  if (kind !== 'implementer') while (round < 50 && (await h.fs.exists(`${wt}/${briefPaths(id, kind, n, round, dir).brief}`))) round++
  if ((kind === 'review' || kind === 'final') && round > 1 && !e.findings?.trim()) throw new Refused(`${briefPaths(id, kind, n, 1, dir).brief} exists: dispatch it again by its path, or pass findings for a scoped re-review`)

  const item = current.items.find(i => i.id === id)!
  const template = await readItemFile(h, found, wt, `docs/pipeline/templates/${kind}.md`)
  const head = kind === 'final' ? await gitOut(h, wt, ['rev-parse', '--short', 'HEAD']) : null
  let out: ReturnType<typeof renderBrief>
  try {
    out = renderBrief({
      kind, item: id, itemTitle: item.title, task: n, round, plan, config: cfg, ledger,
      root: wt,
      places: { specRel: P.specRel(id), planRel: P.planRel(id), recordsDir: P.recordsDir, briefDir: dir },
      rulesMd: (await readItemFile(h, found, wt, 'docs/pipeline/rules.md')) ?? '',
      factsMd: (await readText(h, P.facts)) ?? '',
      principlesMd: (await readItemFile(h, found, wt, PRINCIPLES_FILE)) ?? '',
      // queue: github: the spec cache begin wrote in the worktree.
      specMd: (await readSpec(h, found, wt, c, item, id)) ?? '',
      ...(template ? { template } : {}),
      ...(e.findings !== undefined ? { findings: e.findings } : {}),
      ...(e.carried !== undefined ? { carried: e.carried } : {}),
      ...(e.commits !== undefined ? { commits: e.commits } : {}),
      ...(typeof e.attribution === 'string' ? { attribution: e.attribution } : {}),
      ...(head ? { head } : {}),
      risky,
      isEscalated: e.escalate === true,
    })
  } catch (err) {
    throw new Refused(err instanceof Error ? err.message : String(err))
  }
  await h.fs.write(`${wt}/${out.brief}`, out.text)

  // The dispatch before this one (the implementer's before a fix or a review) is closed in the same call.
  if (e.close && typeof e.close === 'object' && kind !== 'final') await runTool(h, { action: 'ledger', item: id, set: { tasks: [{ n, close: e.close }] } })
  const total = plan.tasks.length
  const state = kind === 'implementer' ? 'implementer dispatched' : kind === 'fix' ? `fix round ${round} dispatched` : kind === 'review' ? 'review dispatched' : 'final review dispatched'
  const set: LedgerSet = { resume: { task: n, state, ...(ledger.resume?.lastVerified ? { lastVerified: ledger.resume.lastVerified } : {}) } }
  if (kind !== 'final') {
    const dispatch = { role: out.role, model: out.model, effort: out.effort, tokens: 0, minutes: 0, result: '', brief: out.brief, report: out.report, ...(risky[0] ? { risky: risky[0] } : {}) }
    // The same brief asked for twice (plan and accept already answer the next one) opens one dispatch, not two.
    const last = ledger.tasks.find(t => t.n === n)?.dispatches.at(-1)
    const isSame = Boolean(last && last.brief === out.brief && !(last.result ?? '').trim() && !(last.minutes ?? 0))
    set.tasks = [{ n, ...(kind === 'implementer' ? { status: 'running' as const } : kind === 'fix' ? { status: 'fix' as const } : {}), dispatches: isSame ? [] : [dispatch as never] }]
  }
  if (typeof e.attribution === 'string') set['attribution'] = e.attribution
  await runTool(h, { action: 'ledger', item: id, set })
  const what = kind === 'final' ? 'final review' : kind === 'fix' ? `task ${n}/${total} · fix round ${round} of ${cfg.limits.fixRounds}` : kind === 'review' ? `task ${n}/${total} · review${round > 1 ? ` ${round}` : ''}` : `task ${n}/${total}`
  return `${id} · ${what} · Agent subagent_type pipeline:${kind === 'review' || kind === 'final' ? 'reviewer' : 'implementer'} model ${out.model} effort ${out.effort} · prompt: Read ${wt}/${out.brief} and follow it.`
}

/** Whether an update starts an item's run: to planning, or to building from another status. */
export const startsRun = (before: Item['status'], after: Item['status']) => (after === 'planning' || after === 'building') && before !== after
