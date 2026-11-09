// One item's ledger (spec §6): the empty shape, the merge the tool applies at each boundary, and its text. Pure.

import type { Dispatch, Final, Item, Ledger, Resume, Ruling, TaskRecord } from '../types'

/** What a `ledger` call may carry: every field optional, task entries partial and merged by `n`, rulings unnumbered. */
export type LedgerSet = {
  tasks?: Array<Partial<TaskRecord> & { n: number; close?: Partial<Dispatch> }>
  rulings?: Array<Omit<Ruling, 'n'> & { n?: number }>
  resume?: Omit<Resume, 'at'> & { at?: string }
  final?: Final | null
  blockers?: string[]
  pr?: string | null
  branch?: string
  worktree?: string
  base?: string
  plan?: string
  [k: string]: unknown
}

/** The fields the merge handles itself; anything else in `set` is copied over as given. */
const HANDLED = new Set(['item', 'tasks', 'rulings', 'resume', 'final', 'blockers', 'tokens'])

/** A ledger with nothing recorded yet. */
export function emptyLedger(item: string): Ledger {
  return { item, pr: null, tasks: [], rulings: [], blockers: [], final: null, tokens: 0 }
}

/** The sum of every dispatch's tokens, plus the final review's when recorded. */
export function totalTokens(ledger: Pick<Ledger, 'tasks' | 'final'>): number {
  const dispatched = (ledger.tasks ?? []).reduce((sum, t) => sum + (t.dispatches ?? []).reduce((s, d) => s + (Number(d.tokens) || 0), 0), 0)
  return dispatched + (Number(ledger.final?.tokens) || 0)
}

/** Whether a dispatch is still running: opened by a `brief` call, with no result and no minutes yet. */
export const isOpenDispatch = (d: Partial<Dispatch>): boolean => !(d.result ?? '').trim() && !(d.minutes ?? 0)

function mergeTask(current: TaskRecord | undefined, set: Partial<TaskRecord> & { n: number; close?: Partial<Dispatch> }): TaskRecord {
  const { dispatches, close, ...rest } = set
  const base: TaskRecord = current ?? { n: set.n, title: '', status: 'pending', dispatches: [] }
  const list = [...(base.dispatches ?? [])]
  // `close` ends the dispatch a `brief` call opened: the last open one, else the last one.
  if (close && typeof close === 'object' && list.length) {
    let at = list.length - 1
    for (let i = list.length - 1; i >= 0; i--) {
      if (isOpenDispatch(list[i]!)) {
        at = i
        break
      }
    }
    list[at] = { ...list[at]!, ...close }
  }
  return { ...base, ...rest, dispatches: [...list, ...((dispatches ?? []) as Dispatch[])] }
}

/**
 * `set` merged into `current`, which is left untouched: tasks by `n` with dispatches appended, rulings appended and
 * numbered, `resume` replaced whole (stamped `at: now` when it carries none), `final` replaced, blockers appended without
 * duplicates, a task's `close` merged into its open dispatch, `tokens` recomputed, the item id kept, every other field copied over.
 */
export function mergeLedger(current: Ledger, set: LedgerSet, now: string): Ledger {
  const out: Ledger = structuredClone(current)
  out.tasks = [...(out.tasks ?? [])]
  out.rulings = [...(out.rulings ?? [])]
  out.blockers = [...(out.blockers ?? [])]

  for (const t of set.tasks ?? []) {
    if (typeof t?.n !== 'number') continue
    const at = out.tasks.findIndex(x => x.n === t.n)
    const merged = mergeTask(at >= 0 ? out.tasks[at] : undefined, t)
    if (at >= 0) out.tasks[at] = merged
    else out.tasks.push(merged)
  }
  out.tasks.sort((a, b) => a.n - b.n)

  for (const r of set.rulings ?? []) {
    if (!r) continue
    const { n: _ignored, ...rest } = r
    out.rulings.push({ ...rest, n: out.rulings.length + 1 })
  }

  if (set.resume) out.resume = { ...set.resume, at: set.resume.at ?? now }
  if (set.final !== undefined) out.final = set.final
  for (const b of set.blockers ?? []) if (!out.blockers.includes(b)) out.blockers.push(b)

  for (const [k, v] of Object.entries(set)) if (!HANDLED.has(k) && v !== undefined) out[k] = v

  out.tokens = totalTokens(out)
  return out
}

const line = (parts: unknown[]) => parts.filter(p => p !== undefined && p !== null && p !== '').join(' · ')

/** `3 dispatches (implementer ×2, reviewer)`; nothing for none. */
function dispatchSummary(dispatches: Dispatch[] | undefined): string | undefined {
  const n = dispatches?.length ?? 0
  if (!n) return undefined
  const counts = new Map<string, number>()
  for (const d of dispatches!) counts.set(d.role, (counts.get(d.role) ?? 0) + 1)
  const roles = [...counts].map(([role, c]) => (c > 1 ? `${role} ×${c}` : role)).join(', ')
  return `${n} dispatch${n === 1 ? '' : 'es'} (${roles})`
}

/**
 * The ledger as text: the resume line first, then branch, worktree and PR, the tasks, the rulings, the blockers,
 * the final verdict and the token total. `item` adds the title and status to the head line.
 */
export function ledgerText(ledger: Ledger, item: Pick<Item, 'title' | 'status' | 'pr'> | null = null): string {
  const total = ledger.tasks?.length ?? 0
  const r = ledger.resume
  const resume = r ? line([`resume: task ${r.task}${total ? `/${total}` : ''}`, r.state, r.lastVerified ? `verified ${r.lastVerified}` : undefined, r.at ? `at ${r.at}` : undefined]) : 'no resume'
  const lines = [line([ledger.item, item?.title, item?.status, resume])]
  const pr = ledger.pr ?? item?.pr
  const where = line([ledger.branch ? `branch ${ledger.branch}` : undefined, ledger.worktree ? `worktree ${ledger.worktree}` : undefined, pr ? `PR ${pr}` : undefined])
  if (where) lines.push(`  ${where}`)
  if (total) {
    lines.push('Tasks')
    for (const t of ledger.tasks) lines.push(`  ${line([`${t.n}`, t.title, t.status, t.commits, dispatchSummary(t.dispatches), t.review?.verdict])}`)
  }
  if (ledger.rulings?.length) {
    lines.push('Rulings')
    for (const x of ledger.rulings) lines.push(`  R${x.n}${x.task !== undefined ? ` (task ${x.task})` : ''}: ${[x.text, x.why, x.costIfWrong].filter(Boolean).join(' — ')}`)
  }
  if (ledger.blockers?.length) {
    lines.push('Blockers')
    for (const b of ledger.blockers) lines.push(`  ${b}`)
  }
  const f = ledger.final
  if (f) {
    lines.push(`Final: ${line([f.verdict, f.gate ? `gate ${f.gate}` : undefined, f.tokens ? `${f.tokens} tokens` : undefined])}`)
    for (const found of f.findings ?? []) lines.push(`  ${found}`)
  }
  if (ledger.tokens) lines.push(`Tokens: ${ledger.tokens}`)
  return lines.join('\n')
}
