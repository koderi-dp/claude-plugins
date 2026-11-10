// The status block of spec §9. Pure: takes and returns plain data. One item's ledger as text is in ledger.ts.

import type { AgentRun, Backlog, Config, Item, ItemStatus, Ledger, QueueFilter, Role, Sibling, Signal, TaskRecord, TaskReview } from '../types'
import type { Readiness } from './backlog'
import type { MergedPending } from './merged'
import { mergedLine } from './merged'
import { ACCENT, BLOCKED, DONE, MUTED, TRACK } from './ui/tokens'

export type StatusInput = {
  /** The item this session runs, when the caller knows it; without it the first active item counts. */
  activeId?: string | null
  config: Config | null
  backlog: Backlog | null
  readiness: Record<string, Readiness>
  /** The active item's ledger, when one is on disk. */
  ledger: Ledger | null
  agents: AgentRun[]
  signals: Signal[]
  /** Milliseconds since the epoch. */
  now: number
  /** The parse error of a pipeline file, as `<file>: line N: <message>`. */
  fileError?: string | null
  /** The items whose PR was merged by hand and whose Close is pending. */
  mergedPending?: MergedPending[]
}

const ACTIVE: ItemStatus[] = ['planning', 'building', 'review']
const QUEUE = 5
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

const minutes = (from: number, to: number) => Math.max(0, Math.round((to - from) / 60000))
const line = (parts: unknown[]) => parts.filter(p => p !== undefined && p !== null && p !== '').join(' · ')

/** `task 3/6` from the ledger's resume block and task list; nothing without a ledger. */
export function taskCounter(ledger: Ledger | null): string | undefined {
  if (!ledger) return undefined
  const total = ledger.tasks?.length ?? 0
  const n = ledger.resume?.task
  if (n === undefined && total === 0) return undefined
  return `task ${n ?? 0}/${total}`
}

/**
 * The title as shown: a migrated title `grid-track-sizes — Grid row and column sizes`
 * (a slug of lowercase words joined by hyphens, then an em dash or a hyphen between spaces)
 * loses its slug. The file and `status <id>` keep the whole title.
 */
export function displayTitle(title: string): string {
  const m = /^[a-z0-9]+(?:-[a-z0-9]+)*\s+(?:—|-)\s+(\S.*)$/.exec(title)
  return m ? m[1]! : title
}

/** The session's name while it runs an item: `p12 · CSV export`, the title without its slug, cut to 60 characters. */
export function sessionName(item: Pick<Item, 'id' | 'title'>): string {
  const title = displayTitle(item.title)
  return `${item.id} · ${title.length > 60 ? title.slice(0, 59).trimEnd() + '…' : title}`
}

/** The PR as `#35` with its address when the record is a URL: from `https://…/pull/35`, `#35` or `35`; nothing otherwise. */
export function prLabel(pr: string | null | undefined): { label: string; href?: string } | undefined {
  if (!pr) return undefined
  const m = /(?:^#?|\/pull\/|\/pulls\/|\/merge_requests\/)(\d+)\/?$/.exec(pr.trim())
  if (!m) return { label: pr }
  return /^https?:\/\//.test(pr.trim()) ? { label: `#${m[1]}`, href: pr.trim() } : { label: `#${m[1]}` }
}

/** The idle line when nothing runs: `idle · 28 inbox · next: p1 Grid row and column sizes`, next being the first ready item, else the first inbox item. */
export function idleLine(items: Item[]): string {
  const inbox = items.filter(i => i.status === 'inbox')
  const next = items.find(i => i.status === 'ready') ?? inbox[0]
  return line(['idle', `${inbox.length} inbox`, next ? `next: ${next.id} ${displayTitle(next.title)}` : undefined])
}

function itemRow(item: Item, extra?: string): string {
  return `  ${line([item.id, displayTitle(item.title), item.size, extra])}`
}

/** The status block: head line, the active item, agents, signals, then the queues. */
export function statusText(input: StatusInput): string {
  const { config, backlog, readiness, ledger, agents, signals, now, fileError } = input
  const lines: string[] = []
  if (fileError) lines.push(`pipeline: ${fileError}`)
  if (!config && !fileError) lines.push('pipeline: no config (run /pipeline init)')
  if (!backlog) {
    if (config && !fileError) lines.push('pipeline: no backlog (run /pipeline init)')
    return [...lines, ...nowLines(agents, signals, now)].join('\n')
  }
  const items = backlog.items
  const ready = items.filter(i => i.status === 'ready')
  if (!fileError) lines.push(`pipeline: ${items.length} item${items.length === 1 ? '' : 's'} · ${ready.length} ready`)
  for (const m of input.mergedPending ?? []) lines.push(mergedLine(m))

  const active = items.filter(i => ACTIVE.includes(i.status))
  if (active.length) {
    lines.push('Active')
    for (const i of active) {
      const own = ledger && ledger.item === i.id ? ledger : null
      lines.push(itemRow(i, line([i.status, taskCounter(own), own?.resume?.state])))
    }
  }
  lines.push(...nowLines(agents, signals, now))

  if (ready.length) {
    lines.push('Ready')
    for (const i of ready.slice(0, QUEUE)) lines.push(itemRow(i, (i.needs ?? []).length ? `needs ${i.needs!.join(' ')}` : undefined))
    if (ready.length > QUEUE) lines.push(`  … and ${ready.length - QUEUE} more ready`)
  }
  const blocked = items.filter(i => i.status === 'blocked')
  if (blocked.length) {
    lines.push('Blocked')
    for (const i of blocked) lines.push(itemRow(i, i.note || 'no reason recorded'))
  }
  const inbox = items.filter(i => i.status === 'inbox')
  if (inbox.length) {
    lines.push('Inbox')
    for (const i of inbox) {
      const r = readiness[i.id]
      lines.push(itemRow(i, r && !r.ready ? r.reason : undefined))
    }
  }
  const parked = items.filter(i => i.status === 'parked')
  if (parked.length) lines.push(`Parked: ${parked.map(i => i.id).join(', ')}`)
  const merged = mergedThisWeek(items, now)
  if (merged.length) {
    lines.push('Merged this week')
    for (const i of merged) lines.push(itemRow(i, i.pr ?? undefined))
  }
  return lines.join('\n')
}

/** Running agents with their activity and minutes, then the signals not yet delivered. */
function nowLines(agents: AgentRun[], signals: Signal[], now: number): string[] {
  const lines: string[] = []
  const running = agents.filter(a => a.status === 'running')
  if (running.length) {
    lines.push('Agents')
    for (const a of running) lines.push(`  ${line([a.name, a.model, `${minutes(a.startedAt, now)} min`, a.activity])}`)
  }
  const open = signals.filter(s => !s.delivered)
  if (open.length) {
    lines.push('Signals')
    for (const s of open) lines.push(`  ${s.kind}: ${line([s.agent, s.detail])}`)
  }
  return lines
}


// ---------- the dashboard's derivations ----------

export const WEEK = WEEK_MS
const isActive = (i: Item) => ACTIVE.includes(i.status)

/** How many items each Queue filter holds: `ready` counts the items in flight too, `all` everything but the merged. */
export function groupCounts(items: Item[]): Record<QueueFilter, number> {
  return {
    inbox: items.filter(i => i.status === 'inbox').length,
    ready: items.filter(i => i.status === 'ready' || isActive(i)).length,
    blocked: items.filter(i => i.status === 'blocked').length,
    parked: items.filter(i => i.status === 'parked').length,
    all: items.filter(i => i.status !== 'merged').length,
  }
}

/** The Queue's rows: the filter's group, in flight first under `ready`, narrowed by the search over id and title. */
export function queueItems(items: Item[], filter: QueueFilter, search: string): Item[] {
  const q = search.trim().toLowerCase()
  const inGroup = (i: Item) =>
    filter === 'all' ? i.status !== 'merged' : filter === 'ready' ? i.status === 'ready' || isActive(i) : i.status === filter
  const matches = (i: Item) => !q || i.id.toLowerCase().includes(q) || displayTitle(i.title).toLowerCase().includes(q)
  const list = items.filter(i => inGroup(i) && matches(i))
  return filter === 'ready' ? [...list.filter(isActive), ...list.filter(i => !isActive(i))] : list
}

/**
 * The merged items newest first; `withinMs` keeps those updated in that window. Equal dates (a migration stamps
 * every imported item with its own date) keep the file's order reversed, the file listing oldest first.
 */
export function mergedItems(items: Item[], now: number, withinMs = Infinity): Item[] {
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item: i }) => i.status === 'merged' && (withinMs === Infinity || (!!i.updatedAt && now - Date.parse(i.updatedAt) <= withinMs)))
    .sort((a, b) => (Date.parse(b.item.updatedAt ?? '') || 0) - (Date.parse(a.item.updatedAt ?? '') || 0) || b.index - a.index)
    .map(({ item }) => item)
}

/**
 * The items the pipeline merged in the last seven days, newest first: an imported item (its note starts with
 * `imported`) carries the migration's date, not a merge date, so it never counts.
 */
export function mergedThisWeek(items: Item[], now: number): Item[] {
  return mergedItems(items, now, WEEK_MS).filter(i => !/^imported\b/i.test(i.note ?? ''))
}

/** The idle hero's sentence: how many wait, how many are ready, and what moves work. */
export function heroSentence(items: Item[]): string {
  const inbox = items.filter(i => i.status === 'inbox').length
  const ready = items.filter(i => i.status === 'ready').length
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`
  if (ready) return `${inbox ? `There are ${n(inbox, 'item')} in your inbox and ` : ''}${inbox ? ready : n(ready, 'item')} ${ready === 1 ? 'is' : 'are'} ready to build. Run /pipeline next to start the first.`
  if (inbox) return `There ${inbox === 1 ? 'is' : 'are'} ${n(inbox, 'item')} in your inbox, but none are ready to build. Add specifications to move work into the queue.`
  return 'The inbox is empty and nothing is ready to build. Add work with /pipeline add.'
}

export type StepState = 'done' | 'current' | 'pending'
export type Step = { name: 'Plan' | 'Build' | 'Review' | 'Merge'; state: StepState }

/** Whether the ledger says the final review is under way: a final block, or a resume state that names it. */
const inFinalReview = (ledger: Ledger | null) => !!ledger && (!!ledger.final || /final/i.test(ledger.resume?.state ?? ''))

/** Plan · Build · Review · Merge for an item: done, current and pending from its status and its ledger. */
export function stepsOf(item: Item | null, ledger: Ledger | null): Step[] {
  const names: Step['name'][] = ['Plan', 'Build', 'Review', 'Merge']
  const current = !item ? -1 : item.status === 'merged' ? 4 : item.status === 'review' || (item.status === 'building' && inFinalReview(ledger)) ? 2 : item.status === 'building' ? 1 : item.status === 'planning' ? 0 : -1
  return names.map((name, i) => ({ name, state: i < current ? 'done' : i === current ? 'current' : 'pending' }))
}

/**
 * The one task an agent works on: the resume block's task when it names one that is not accepted, else the first
 * task that is running or in a fix round. A ledger may hold several such tasks at once; only this one is current.
 */
export function currentTask(ledger: Ledger | null): TaskRecord | undefined {
  if (!ledger) return undefined
  const tasks = ledger.tasks ?? []
  return tasks.find(t => t.n === ledger.resume?.task && t.status !== 'accepted') ?? tasks.find(t => t.status === 'running' || t.status === 'fix')
}

const ROLES: Role[] = ['implementer', 'reviewer', 'final', 'escalate']

/** The role of a running agent: the current task's last dispatch when the ledger has one, else a role its name spells, else its name. */
export function roleOf(agent: Pick<AgentRun, 'name'>, ledger: Ledger | null): { role: string; effort?: string } {
  const last = (currentTask(ledger)?.dispatches ?? []).at(-1)
  if (last && ROLES.includes(last.role)) return { role: last.role, ...(last.effort && last.effort !== 'default' ? { effort: last.effort } : {}) }
  const name = agent.name.toLowerCase()
  if (/final/.test(name)) return { role: 'final' }
  if (/review/.test(name)) return { role: 'reviewer' }
  if (/implement|build|task \d/.test(name)) return { role: 'implementer' }
  return { role: agent.name }
}

/**
 * The finished agents the running view lists for the current task while its ledger has no dispatch yet: those whose
 * name says `task N` (as a word, so task 3 is not task 30) and those that started after the task's dispatch, which the
 * resume block dates when it is this task's. An earlier task's agents, accepted or failed, are not the current task's.
 * Without a current task every finished agent is listed.
 */
export function finishedOfTask(agents: AgentRun[], current: Pick<TaskRecord, 'n'> | undefined, ledger: Ledger | null): AgentRun[] {
  const finished = agents.filter(a => a.status !== 'running')
  if (!current) return finished
  const named = new RegExp(`\\btask ${current.n}\\b`, 'i')
  const since = ledger?.resume?.task === current.n ? Date.parse(ledger.resume.at ?? '') : NaN
  return finished.filter(a => named.test(a.name) || (!Number.isNaN(since) && a.startedAt >= since))
}

/**
 * Another session's row: its title, then `p12 · 1 agent · stale`. A session with no item and no agents is an idle
 * session, `idle session · <title>`, the title being the live entry's or the folder's name, with only `stale` beside it.
 */
export function siblingLabel(s: Sibling): { title: string; meta: string; isIdle: boolean } {
  const name = s.title || s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'session'
  const isIdle = !s.item && !s.agents.length
  if (isIdle) return { title: `idle session · ${name}`, meta: s.isStale ? 'stale' : '', isIdle }
  const running = s.agents.filter(a => a.status === 'running').length
  return { title: name, meta: line([s.item, `${running} agent${running === 1 ? '' : 's'}`, s.isStale ? 'stale' : undefined]), isIdle }
}

export type Verdict = 'APPROVED' | 'FIX REQUIRED'
export type Attempt = {
  /** `Build`, `Review`, `Fix 1 of 3`, `Final review`, `Escalation`. */
  label: string
  model: string
  /** The dispatch's minutes as a clock, `3:20`. */
  time: string
  verdict?: Verdict
  /** A line of its own, dim, with no model or time: how an accepted task was reviewed. */
  isNote?: boolean
  /** The dispatch has no result yet: it is the one still running. */
  isOpen?: boolean
}

const verdictOf = (result: string): Verdict | undefined => (/FIX REQUIRED/i.test(result) ? 'FIX REQUIRED' : /APPROVED/i.test(result) ? 'APPROVED' : undefined)

/**
 * A task's attempt trail from its dispatches, in order: the first implementer dispatch is the Build, each later
 * one a fix round counted within the task against `fixRounds`; a review carries the verdict its result names.
 */
export function attemptsOf(task: Pick<TaskRecord, 'dispatches'> & Partial<Pick<TaskRecord, 'status' | 'review'>> | undefined, fixRounds: number, taskReview?: TaskReview): Attempt[] {
  let builds = 0
  const note = task ? reviewNote(task, taskReview) : undefined
  const trail = (task?.dispatches ?? []).map((d): Attempt => {
    let label: string
    if (d.role === 'implementer') {
      builds += 1
      label = builds === 1 ? 'Build' : `Fix ${builds - 1} of ${fixRounds}`
    } else label = d.role === 'reviewer' ? 'Review' : d.role === 'final' ? 'Final review' : 'Escalation'
    const verdict = verdictOf(d.result ?? '')
    // A dispatch with no result yet is the one still running: no clock, no check.
    const isOpen = !(d.result ?? '').trim() && !(d.minutes ?? 0)
    return { label, model: shortModel(d.model), time: fmtClock((d.minutes ?? 0) * 60_000), ...(verdict ? { verdict } : {}), ...(isOpen ? { isOpen: true } : {}) }
  })
  return note ? [...trail, { label: note, model: '', time: '', isNote: true }] : trail
}

/**
 * How an accepted task was reviewed when no independent reviewer ran (`review.kind` is `lead-diff`):
 * `review skipped (taskReview off)` when the config turns per-task review off, `lead read the diff` otherwise.
 */
export function reviewNote(task: Partial<Pick<TaskRecord, 'status' | 'review'>>, taskReview?: TaskReview): string | undefined {
  if (task.status !== 'accepted' || task.review?.kind !== 'lead-diff') return undefined
  return taskReview === 'off' ? 'review skipped (taskReview off)' : 'lead read the diff'
}

/** An attempt as one line: `Build · Sonnet · 3:20 ✓`, `Review · Opus · 0:58 · FIX REQUIRED`. */
export const attemptText = (a: Attempt): string =>
  a.isNote ? a.label : a.isOpen ? `${line([a.label, a.model])} · in progress` : `${line([a.label, a.model, a.time])}${a.verdict ? ` · ${a.verdict}` : ' ✓'}`

/**
 * The current task's second line: in a fix round, `Fix round 1 of 3 · after review: FIX REQUIRED`; with an agent
 * running, its role, model and clock (`Implementer · Sonnet · 1:48`, `Review · Opus · 0:58`); otherwise the last
 * dispatch's model.
 */
export function currentLine(task: TaskRecord, agent: AgentRun | undefined, ledger: Ledger | null, fixRounds: number, now: number): string {
  const attempts = attemptsOf(task, fixRounds)
  if (task.status === 'fix') {
    const fixes = attempts.filter(a => a.label.startsWith('Fix ')).length
    const review = [...attempts].reverse().find(a => a.label === 'Review' || a.label === 'Final review')
    return line([`Fix round ${Math.max(1, fixes)} of ${fixRounds}`, review?.verdict ? `after review: ${review.verdict}` : undefined])
  }
  if (agent) {
    const role = roleOf(agent, ledger).role
    const word = role === 'reviewer' ? 'Review' : role === 'final' ? 'Final review' : role === 'implementer' ? 'Implementer' : role.charAt(0).toUpperCase() + role.slice(1)
    return line([word, shortModel(agent.model), fmtClock(now - agent.startedAt)])
  }
  const last = (task.dispatches ?? []).at(-1)
  return last ? shortModel(last.model) : ''
}

/** What the lead does while no agent runs: `Lead · fix round 1 dispatched · 2:10`, the state from the resume block and the time since it. */
export function leadLine(ledger: Ledger | null, now: number): string {
  const state = ledger?.resume?.state || 'between dispatches'
  const at = Date.parse(ledger?.resume?.at ?? '')
  return line(['Lead', state, Number.isNaN(at) ? undefined : fmtClock(Math.max(0, now - at))])
}

// ---------- the task list of the running Overview ----------

export type TaskRowKind = 'done' | 'current' | 'pending' | 'blocked'
export type BadgeKind = 'done' | 'running' | 'pending' | 'blocked'
/** The running agent of the current task, as its card shows it. */
export type TaskAgent = { role: string; model: string; activity: string; calls: number; tokens: number; elapsedMs: number }
export type TaskRow = {
  n: number
  kind: TaskRowKind
  /** `01 · COMPLETED`, `02 · CURRENT TASK`, `03 · NEXT TASK`, `04 · PENDING`, `02 · BLOCKED`. */
  eyebrow: string
  /** `Accepted`, `● Running`, `Fix round 1 of 2`, `In review`, `Pending`, `Blocked`. */
  badge: string
  badgeKind: BadgeKind
  title: string
  /** `Implemented by Opus 5.5 · 4m 34s · review skipped (taskReview off)`; `Implementation · in progress`; a fix round's line. */
  sub?: string
  /** The current task's running agent. */
  agent?: TaskAgent
  /** The current task's lead line while no agent runs: `Lead · fix round 1 dispatched · 0:40`. */
  lead?: string
  /** Under the lead line: the attempt trail when the ledger has dispatches, else the task's finished agents. */
  history: { text: string; kind: 'done' | 'blocked' | 'muted' }[]
}

/** `4m 34s`, `45s`, `1h 02m`. */
export const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const roleWord = (role: string): string => (role === 'reviewer' ? 'Review' : role === 'final' ? 'Final review' : role === 'implementer' ? 'Implementation' : role.charAt(0).toUpperCase() + role.slice(1))

/** How an accepted task was reviewed, short: the lead's note, else `review <verdict>` of an independent review. */
const reviewedAs = (task: TaskRecord, taskReview?: TaskReview): string | undefined => reviewNote(task, taskReview) ?? (task.review?.kind === 'independent' ? `review ${task.review.verdict}` : undefined)

/** `Implemented by Opus 5.5 · 4m 34s` from the task's last implementer dispatch; nothing without one. */
const implementedBy = (task: TaskRecord): string | undefined => {
  const d = [...(task.dispatches ?? [])].reverse().find(x => x.role === 'implementer')
  return d ? `Implemented by ${shortModel(d.model)} · ${fmtDuration((d.minutes ?? 0) * 60_000)}` : undefined
}

export type TaskRowsInput = { tasks: TaskRecord[]; agents: AgentRun[]; ledger: Ledger | null; fixRounds: number; taskReview?: TaskReview; now: number }

/**
 * One row per ledger task for the running Overview: the eyebrow, the badge, the sub-line, and for the current task
 * its running agent, or the lead line with the attempt trail (a fix round) or the task's finished agents under it.
 */
export function taskRowsOf(d: TaskRowsInput): TaskRow[] {
  const current = currentTask(d.ledger)
  const agent = [...d.agents].reverse().find(a => a.status === 'running')
  let sawCurrent = false
  let sawNext = false
  return d.tasks.map((task): TaskRow => {
    const title = task.title
    if (task.status === 'accepted') {
      return { n: task.n, kind: 'done', eyebrow: `${pad2(task.n)} · COMPLETED`, badge: 'Accepted', badgeKind: 'done', title, sub: line([implementedBy(task), reviewedAs(task, d.taskReview)]) || undefined, history: [] }
    }
    if (task.status === 'blocked') {
      return { n: task.n, kind: 'blocked', eyebrow: `${pad2(task.n)} · BLOCKED`, badge: 'Blocked', badgeKind: 'blocked', title, sub: task.review?.verdict || undefined, history: [] }
    }
    const isCurrent = task.n === current?.n
    const fixBadge = () => `Fix round ${Math.max(1, attemptsOf(task, d.fixRounds).filter(a => a.label.startsWith('Fix ')).length)} of ${d.fixRounds}`
    // A second task the ledger marks running or in a fix round: a plain row with its own badge, no card and no agent.
    if (!isCurrent && (task.status === 'running' || task.status === 'fix')) {
      return { n: task.n, kind: 'pending', eyebrow: `${pad2(task.n)} · IN PROGRESS`, badge: task.status === 'fix' ? fixBadge() : 'In progress', badgeKind: 'running', title, history: [] }
    }
    if (!isCurrent) {
      const eyebrow = sawCurrent && !sawNext ? 'NEXT TASK' : 'PENDING'
      if (sawCurrent) sawNext = true
      return { n: task.n, kind: 'pending', eyebrow: `${pad2(task.n)} · ${eyebrow}`, badge: 'Pending', badgeKind: 'pending', title, history: [] }
    }
    sawCurrent = true
    const attempts = attemptsOf(task, d.fixRounds)
    const role = agent ? roleOf(agent, d.ledger) : undefined
    const isReview = role?.role === 'reviewer' || role?.role === 'final'
    const badge = task.status === 'fix' ? fixBadge() : isReview ? 'In review' : '● Running'
    const lastRole = (task.dispatches ?? []).at(-1)?.role
    const sub = task.status === 'fix' ? currentLine(task, undefined, d.ledger, d.fixRounds, d.now) : `${roleWord(role?.role ?? lastRole ?? 'implementer')} · in progress`
    const row: TaskRow = { n: task.n, kind: 'current', eyebrow: `${pad2(task.n)} · CURRENT TASK`, badge, badgeKind: 'running', title, sub, history: [] }
    if (agent && role) {
      row.agent = { role: role.role.charAt(0).toUpperCase() + role.role.slice(1), model: line([shortModel(agent.model), role.effort]), activity: agent.activity, calls: agent.calls, tokens: agent.tokens, elapsedMs: Math.max(0, d.now - agent.startedAt) }
      return row
    }
    row.lead = leadLine(d.ledger, d.now)
    row.history = attempts.length
      ? attempts.map(a => ({ text: attemptText(a), kind: a.isNote || a.isOpen ? ('muted' as const) : a.verdict === 'FIX REQUIRED' ? ('blocked' as const) : ('done' as const) }))
      : finishedOfTask(d.agents, task, d.ledger)
          .slice(-3)
          .reverse()
          .map(a => ({ text: line([a.name, shortModel(a.model), fmtClock((a.endedAt ?? d.now) - a.startedAt), a.status]), kind: a.status === 'failed' ? ('blocked' as const) : ('muted' as const) }))
    return row
  })
}

/** The Recent activity rows: one per accepted task, `✓ Task 1 accepted · Implementer (Opus 5.5) · 4:34 · review skipped`. */
export function activityLines(tasks: TaskRecord[], taskReview?: TaskReview): string[] {
  return tasks
    .filter(t => t.status === 'accepted')
    .map(t => {
      const dispatches = t.dispatches ?? []
      const impl = dispatches.find(x => x.role === 'implementer')
      const minutes = dispatches.reduce((sum, x) => sum + (x.minutes ?? 0), 0)
      const note = reviewNote(t, taskReview)
      const review = note ? note.replace(/ \(taskReview off\)$/, '') : t.review?.kind === 'independent' ? `review ${t.review.verdict}` : undefined
      return line([`✓ Task ${t.n} accepted`, impl ? `Implementer (${shortModel(impl.model)})` : undefined, dispatches.length ? fmtClock(minutes * 60_000) : undefined, review])
    })
}

export type TagKind = 'running' | 'done' | 'blocked' | 'muted' | 'ready'

/** The status tag of a row: the word and its colour kind; an inbox item not ready shows its reason (`No spec`). */
export function tagOf(item: Item, reason?: string): { text: string; kind: TagKind } {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  switch (item.status) {
    case 'inbox':
      return reason ? { text: cap(reason), kind: 'blocked' } : { text: 'Inbox', kind: 'muted' }
    case 'ready':
      return { text: 'Ready', kind: 'ready' }
    case 'blocked':
      return { text: 'Blocked', kind: 'blocked' }
    case 'parked':
      return { text: 'Parked', kind: 'muted' }
    case 'merged':
      return { text: 'Merged', kind: 'done' }
    default:
      return { text: cap(item.status), kind: 'running' }
  }
}

/** The first line of a spec's What: the first paragraph under a heading that names it, else the first paragraph; cut to 160 characters. */
export function specWhat(text: string): string {
  const lines = text.split(/\r?\n/)
  const isHeading = (l: string) => /^#{1,6}\s/.test(l)
  const at = lines.findIndex(l => /^#{1,6}\s*(what|goal|summary)\b/i.test(l))
  const body = lines.slice(at >= 0 ? at + 1 : 0)
  const first = body.find(l => l.trim() && !isHeading(l) && !/^[-*|>]/.test(l.trim()) && !/^[A-Za-z ]+:\s*\S/.test(l) && !(at < 0 && isHeading(l)))
  const out = (first ?? '').trim().replace(/\s+/g, ' ')
  return out.length > 160 ? out.slice(0, 159).trimEnd() + '…' : out
}

// ---------- the band above the prompt ----------

export type Segment = 'accepted' | 'current' | 'blocked' | 'pending'
export type Band = {
  id: string
  title: string
  /** The state tag: BUILDING, REVIEW, BLOCKED, MERGED, READY. */
  state: string
  /** The state's colour. */
  color: string
  /** `Task 1 / 3`, `3 / 3 accepted`, `3 tasks`. */
  count: string
  /** One per ledger task. */
  segments: Segment[]
  /** `Implementer · Sonnet 5.5 · running npm run lint`. */
  activity: string
  /** The running agent's elapsed, `—` without one. */
  clock: string
  /** `0 accepted · 1 running`, for the expansion. */
  summary: string
  tasks: { title: string; segment: Segment }[]
}

/** A task's segment of the bar: accepted, blocked, current (the one current task; without one, a task that is running or in a fix round), else pending. */
export const taskSegment = (t: TaskRecord, current: Pick<TaskRecord, 'n'> | undefined): Segment => (t.status === 'accepted' ? 'accepted' : t.status === 'blocked' ? 'blocked' : (current ? t.n === current.n : t.status === 'running' || t.status === 'fix') ? 'current' : 'pending')

/** `1 accepted · 1 in progress · 1 pending`, with `n blocked` when any is; the legend under the task bar. */
export function segmentLegend(segments: Segment[]): { n: number; word: string; kind: Segment }[] {
  const count = (kind: Segment) => segments.filter(s => s === kind).length
  const out: { n: number; word: string; kind: Segment }[] = [
    { n: count('accepted'), word: 'accepted', kind: 'accepted' },
    { n: count('current'), word: 'in progress', kind: 'current' },
    { n: count('pending'), word: 'pending', kind: 'pending' },
  ]
  if (count('blocked')) out.push({ n: count('blocked'), word: 'blocked', kind: 'blocked' })
  return out
}

// The band's colours are the tokens': the drawn band maps them back to a tone, a Text takes them as they are.
export const BAND_COLORS = { running: ACCENT, blocked: BLOCKED, merged: DONE, idle: MUTED } as const
export const SEGMENT_COLORS: Record<Segment, string> = { accepted: DONE, current: ACCENT, blocked: BLOCKED, pending: TRACK }

const fmtClock = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** The short model name of an id: `Sonnet 5.5`, `Opus 5`; the id itself for an unknown one. */
const shortModel = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

/** The band's data for an item: its state, the task count and segments from the ledger, the agent's activity and clock. */
export function bandOf(item: Item, ledger: Ledger | null, agent: AgentRun | undefined, now: number): Band {
  const tasks = ledger?.tasks ?? []
  const current = currentTask(ledger)
  const segmentOf = (t: TaskRecord): Segment => taskSegment(t, current)
  const segments = tasks.map(segmentOf)
  const accepted = segments.filter(s => s === 'accepted').length
  const isRunning = ACTIVE.includes(item.status)
  const color = isRunning ? BAND_COLORS.running : item.status === 'blocked' ? BAND_COLORS.blocked : item.status === 'merged' ? BAND_COLORS.merged : BAND_COLORS.idle
  const count = item.status === 'merged' ? `${accepted} / ${tasks.length} accepted` : isRunning || item.status === 'blocked' ? (current ? `Task ${current.n} / ${tasks.length}` : tasks.length ? `${accepted} / ${tasks.length} accepted` : '') : `${tasks.length} task${tasks.length === 1 ? '' : 's'}`
  const role = agent ? roleOf(agent, ledger).role : ''
  const activity = agent
    ? line([role.charAt(0).toUpperCase() + role.slice(1), shortModel(agent.model), agent.activity])
    : item.status === 'blocked'
      ? item.note || 'Blocked · needs attention'
      : item.status === 'merged'
        ? line(['Merged', prLabel(item.pr)?.label])
        : isRunning
          ? ledger?.resume?.state || 'Waiting for the next dispatch'
          : 'Next in queue · waiting to start'
  const running = segments.filter(s => s === 'current').length
  const blocked = segments.filter(s => s === 'blocked').length
  const summary = line([`${accepted} accepted`, running ? `${running} ${item.status === 'review' ? 'in review' : 'running'}` : '', blocked ? `${blocked} blocked` : '', item.status === 'merged' ? 'merged' : '', !running && !blocked && item.status !== 'merged' ? `${tasks.length - accepted} pending` : ''])
  return {
    id: item.id,
    title: displayTitle(item.title),
    state: item.status === 'ready' || item.status === 'inbox' ? 'READY' : item.status.toUpperCase(),
    color,
    count,
    segments,
    activity,
    clock: agent ? fmtClock(now - agent.startedAt) : '—',
    summary,
    tasks: tasks.map(t => ({ title: t.title, segment: segmentOf(t) })),
  }
}
