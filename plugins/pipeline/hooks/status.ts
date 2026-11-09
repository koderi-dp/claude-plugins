// The status block of spec §9. Pure: takes and returns plain data. One item's ledger as text is in ledger.ts.

import type { AgentRun, Backlog, Config, Item, ItemStatus, Ledger, QueueFilter, Role, Signal, TaskRecord } from '../types'
import type { Readiness } from './backlog'

export type StatusInput = {
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
  const merged = items.filter(i => i.status === 'merged' && i.updatedAt && now - Date.parse(i.updatedAt) <= WEEK_MS)
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

/** The merged items newest first; `withinMs` keeps those updated in that window. */
export function mergedItems(items: Item[], now: number, withinMs = Infinity): Item[] {
  return items
    .filter(i => i.status === 'merged' && (withinMs === Infinity || (!!i.updatedAt && now - Date.parse(i.updatedAt) <= withinMs)))
    .sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0))
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

/** The task an agent works on: the ledger's running or fix task, else the resume block's. */
export function currentTask(ledger: Ledger | null): TaskRecord | undefined {
  if (!ledger) return undefined
  const tasks = ledger.tasks ?? []
  return tasks.find(t => t.status === 'running' || t.status === 'fix') ?? tasks.find(t => t.n === ledger.resume?.task)
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

export const BAND_COLORS = { running: '#b69aff', blocked: '#f0b56f', merged: '#6dd9a1', idle: '#96929f' } as const
export const SEGMENT_COLORS: Record<Segment, string> = { accepted: '#69c99a', current: '#a990fc', blocked: '#f0b56f', pending: '#404048' }

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
  const segmentOf = (t: TaskRecord): Segment => (t.status === 'accepted' ? 'accepted' : t.status === 'blocked' ? 'blocked' : t.status === 'running' || t.status === 'fix' || t.n === current?.n ? 'current' : 'pending')
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
