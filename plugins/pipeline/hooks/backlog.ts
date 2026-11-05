// The backlog: items, order, readiness and the generated BACKLOG.md. Pure: takes and returns plain data.

import type { Backlog, Item, ItemStatus } from '../types'

const ACTIVE: ItemStatus[] = ['planning', 'building', 'review']

export function emptyBacklog(): Backlog {
  return { version: 1, items: [] }
}

/** `p` plus the smallest number no item uses. */
export function nextId(backlog: Backlog): string {
  const used = new Set(backlog.items.map(i => i.id))
  let n = 1
  while (used.has(`p${n}`)) n++
  return `p${n}`
}

/** Appends an item with the next id, every known field present, and the stamp; unknown fields are kept. */
export function addItem(backlog: Backlog, fields: Partial<Item> & { title: string }, now: string): Backlog {
  const item: Item = {
    id: nextId(backlog),
    status: 'inbox',
    source: '',
    spec: null,
    plan: null,
    branch: null,
    pr: null,
    ledger: null,
    note: '',
    ...fields,
    title: fields.title,
    updatedAt: now,
  }
  return { ...backlog, items: [...backlog.items, item] }
}

/** Merges fields into the item; `updatedAt` is stamped only when the status changes. Unknown id: unchanged. */
export function updateItem(backlog: Backlog, id: string, fields: Partial<Item>, now: string): Backlog {
  const items = backlog.items.map(i => {
    if (i.id !== id) return i
    const next: Item = { ...i, ...fields, id: i.id }
    if (fields.status !== undefined && fields.status !== i.status) next.updatedAt = now
    return next
  })
  return { ...backlog, items }
}

/** Moves the item to the top or right after another; an unknown id leaves the order alone. */
export function moveItem(backlog: Backlog, id: string, to: 'top' | { after: string }): Backlog {
  const item = backlog.items.find(i => i.id === id)
  if (!item) return backlog
  const rest = backlog.items.filter(i => i.id !== id)
  if (to === 'top') return { ...backlog, items: [item, ...rest] }
  const at = rest.findIndex(i => i.id === to.after)
  if (at < 0 || to.after === id) return backlog
  return { ...backlog, items: [...rest.slice(0, at + 1), item, ...rest.slice(at + 1)] }
}

export function removeItem(backlog: Backlog, id: string): Backlog {
  return { ...backlog, items: backlog.items.filter(i => i.id !== id) }
}

export type ReadinessInput = { backlog: Backlog; specExists: (item: Item) => boolean; specHasOpen: (item: Item) => boolean }
export type Readiness = { ready: true } | { ready: false; reason: string }

/** For every inbox or ready item: ready, or the first reason it is not. */
export function readiness(input: ReadinessInput): Record<string, Readiness> {
  const byId = new Map(input.backlog.items.map(i => [i.id, i]))
  const out: Record<string, Readiness> = {}
  for (const item of input.backlog.items) {
    if (item.status !== 'inbox' && item.status !== 'ready') continue
    out[item.id] = judge(item, byId, input)
  }
  return out
}

function judge(item: Item, byId: Map<string, Item>, input: ReadinessInput): Readiness {
  for (const need of item.needs ?? []) {
    const dep = byId.get(need)
    if (!dep) return { ready: false, reason: `${need} does not exist` }
    if (dep.status === 'parked') return { ready: false, reason: `${need} is parked` }
    if (dep.status !== 'merged') return { ready: false, reason: `waits for ${need}` }
  }
  if (!input.specExists(item)) return { ready: false, reason: 'no spec' }
  if (input.specHasOpen(item)) return { ready: false, reason: 'open question in the spec' }
  return { ready: true }
}

/** The first item in priority order that is ready, or null. */
export function firstReady(input: ReadinessInput): Item | null {
  const r = readiness(input)
  return input.backlog.items.find(i => r[i.id]?.ready) ?? null
}

const SECTIONS: [string, ItemStatus[]][] = [
  ['Active', ACTIVE],
  ['Ready', ['ready']],
  ['Inbox', ['inbox']],
  ['Blocked', ['blocked']],
  ['Parked', ['parked']],
  ['Merged', ['merged']],
]

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
  return s ? ` ${s} ` : ' '
}
const row = (cells: unknown[]) => `|${cells.map(cell).join('|')}|`

/** The generated view: one table per non-empty section, in the order active, ready, inbox, blocked, parked, merged. */
export function renderBacklogMd(backlog: Backlog): string {
  const lines = ['<!-- Generated from backlog.json by the pipeline plugin; not edited by hand. -->', '', '# Backlog', '']
  let any = false
  for (const [heading, statuses] of SECTIONS) {
    const items = backlog.items.filter(i => statuses.includes(i.status))
    if (!items.length) continue
    any = true
    lines.push(`## ${heading}`, '', row(['Id', 'Title', 'Size', 'Needs', 'Note or PR']), '|---|---|---|---|---|')
    for (const i of items) lines.push(row([i.id, i.title, i.size, (i.needs ?? []).join(' '), i.pr ? i.pr : i.note]))
    lines.push('')
  }
  if (!any) lines.push('No items.', '')
  return lines.join('\n')
}
