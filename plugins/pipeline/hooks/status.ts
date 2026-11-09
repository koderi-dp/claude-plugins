// The status block of spec §9. Pure: takes and returns plain data. One item's ledger as text is in ledger.ts.

import type { AgentRun, Backlog, Config, Item, ItemStatus, Ledger, Signal } from '../types'
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
