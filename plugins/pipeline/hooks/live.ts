// The live file of spec §8: one entry per running session, keyed by session id,
// never committed. Pure: the caller reads and writes through the engine.

import type { AgentRun, Live, LiveEntry, Signal } from '../types'

/** An entry no heartbeat refreshed for a day is dropped on the next write. */
export const DROP_MS = 24 * 60 * 60_000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function entryOf(v: Record<string, unknown>): LiveEntry {
  const agents = (Array.isArray(v['agents']) ? v['agents'] : []).filter(isObject) as unknown as AgentRun[]
  const signals = (Array.isArray(v['signals']) ? v['signals'] : []).filter(isObject) as unknown as Signal[]
  const { branch, item, ...rest } = v
  return {
    ...rest,
    title: str(v['title']),
    cwd: str(v['cwd']),
    ...(typeof branch === 'string' ? { branch } : {}),
    ...(typeof item === 'string' ? { item } : {}),
    startedAt: str(v['startedAt']),
    seenAt: str(v['seenAt']),
    agents,
    signals,
  }
}

/** The live file's text as data; anything that is not a sessions map gives no sessions. Unknown fields survive. */
export function parseLive(text: string): Live {
  try {
    const data: unknown = JSON.parse(text)
    if (!isObject(data) || !isObject(data['sessions'])) return { sessions: {} }
    const sessions: Record<string, LiveEntry> = {}
    for (const [id, v] of Object.entries(data['sessions'])) if (isObject(v)) sessions[id] = entryOf(v)
    return { ...data, sessions }
  } catch {
    return { sessions: {} }
  }
}

const ageOf = (s: LiveEntry, nowMs: number) => {
  const t = Date.parse(s.seenAt)
  return Number.isNaN(t) ? Infinity : nowMs - t
}

/** This session's entry replaced, the others kept unless a day old. */
export function withEntry(live: Live, id: string, entry: LiveEntry, nowMs: number): Live {
  const sessions: Record<string, LiveEntry> = {}
  for (const [k, s] of Object.entries(live.sessions)) if (k !== id && ageOf(s, nowMs) <= DROP_MS) sessions[k] = s
  sessions[id] = entry
  return { ...live, sessions }
}

/** The live file without one session. */
export function withoutEntry(live: Live, id: string): Live {
  const sessions = { ...live.sessions }
  delete sessions[id]
  return { ...live, sessions }
}
