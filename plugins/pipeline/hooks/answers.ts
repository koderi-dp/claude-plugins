// The tool's lean answers: the default `get`, the one-line write answers and the signals answer. Every tool answer
// stays in the lead's conversation and is read again on every later call, so these carry what the run skill reads
// and nothing more; `get { full: true }` and `status` remain the ways to read everything.
import type { Backlog, ChildSession, Config, Item, Ledger, Sibling, Signal } from '../types'
import type { Readiness } from './backlog'

export type SlimInput = {
  config: Config | null
  backlog: Backlog | null
  readiness: Record<string, Readiness>
  active: Item | null
  ledger: Ledger | null
  signals: Signal[]
  children: Omit<ChildSession, 'log'>[]
  siblings: Sibling[]
}

/** How many queue items `next` names. */
export const NEXT = 3

/** The keys of the config the run skill reads; the rest (stop, afterMerge, retain, notify…) is read from the file when needed. */
const CONFIG_KEYS = ['runner', 'merge', 'mergeMethod', 'checks', 'limits', 'riskyPaths', 'protectedPaths', 'models', 'taskReview'] as const

/**
 * The default `get` answer: the active item with its branch and worktree, its resume block, the open signals, the
 * children without their logs, the other sessions in short, the counts per status, the first ready (else inbox)
 * items and the config keys a run reads. Planning items count as building.
 */
export function slimGet(input: SlimInput): Record<string, unknown> {
  const { config: c, backlog: b, readiness: r, active, ledger } = input
  const items = b?.items ?? []
  const counts = { inbox: 0, ready: 0, building: 0, review: 0, blocked: 0, parked: 0, merged: 0 }
  for (const i of items) {
    const key = i.status === 'planning' ? 'building' : i.status
    if (key in counts) counts[key as keyof typeof counts]++
  }
  const queue = [...items.filter(i => i.status === 'ready'), ...items.filter(i => i.status === 'inbox')].slice(0, NEXT)
  const next = queue.map(i => {
    const judged = r[i.id]
    const reason = i.status === 'ready' ? 'ready' : judged && !judged.ready ? judged.reason : 'ready'
    return { id: i.id, title: i.title, ...(i.size ? { size: i.size } : {}), reason }
  })
  const config: Record<string, unknown> | null = c ? {} : null
  if (c && config) for (const k of CONFIG_KEYS) if (c[k] !== undefined) config[k] = c[k]
  return {
    active: active
      ? {
          id: active.id,
          title: active.title,
          status: active.status,
          note: active.note ?? '',
          spec: active.spec ?? null,
          plan: active.plan ?? ledger?.plan ?? null,
          branch: active.branch ?? ledger?.branch ?? null,
          worktree: ledger?.worktree ?? null,
        }
      : null,
    resume: ledger?.resume ?? null,
    signals: input.signals.map(compactSignal),
    children: input.children,
    siblings: input.siblings.map(s => ({ sessionId: s.sessionId, title: s.title, ...(s.item ? { item: s.item } : {}), ...(s.branch ? { branch: s.branch } : {}), isStale: s.isStale })),
    counts,
    next,
    config,
  }
}

/** A signal without its bookkeeping: what happened to which agent, and when. */
export function compactSignal(s: Signal): Record<string, unknown> {
  return { kind: s.kind, agent: s.agent, ...(s.agentId ? { agentId: s.agentId } : {}), detail: s.detail, at: s.at }
}
