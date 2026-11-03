// Pure: the shared live file (one entry per running session), staleness and
// where the files live. Nothing here imports the engine.
import type { Live, LiveAgent, LiveSession } from '../types'

export const QUIET_MS = 3 * 60_000
export const DROP_MS = 60 * 60_000

export type Others = Array<LiveSession & { id: string; isQuiet: boolean }>

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function sessionOf(v: Record<string, unknown>): LiveSession {
  const agents: LiveAgent[] = (Array.isArray(v.agents) ? v.agents : [])
    .filter(isObject)
    .map(a => ({ name: str(a.name), model: str(a.model), startedAt: str(a.startedAt), activity: str(a.activity) }))
  return {
    title: str(v.title),
    cwd: str(v.cwd),
    ...(typeof v.branch === 'string' ? { branch: v.branch } : {}),
    ...(typeof v.item === 'string' ? { item: v.item } : {}),
    startedAt: str(v.startedAt),
    seenAt: str(v.seenAt),
    agents,
  }
}

export function parseLive(text: string): Live {
  try {
    const data: unknown = JSON.parse(text)
    if (!isObject(data) || !isObject(data.sessions)) return { sessions: {} }
    const sessions: Record<string, LiveSession> = {}
    for (const [id, v] of Object.entries(data.sessions)) if (isObject(v)) sessions[id] = sessionOf(v)
    return { sessions }
  } catch {
    return { sessions: {} }
  }
}

const ageOf = (s: LiveSession, nowMs: number) => {
  const t = Date.parse(s.seenAt)
  return Number.isNaN(t) ? Infinity : nowMs - t
}

export function withEntry(live: Live, id: string, entry: LiveSession, nowMs: number): Live {
  const sessions: Record<string, LiveSession> = {}
  for (const [k, s] of Object.entries(live.sessions)) if (k !== id && ageOf(s, nowMs) <= DROP_MS) sessions[k] = s
  sessions[id] = entry
  return { sessions }
}

export function withoutEntry(live: Live, id: string): Live {
  const sessions = { ...live.sessions }
  delete sessions[id]
  return { sessions }
}

export function others(live: Live, selfId: string, nowMs: number): Others {
  return Object.entries(live.sessions)
    .filter(([id, s]) => id !== selfId && ageOf(s, nowMs) <= DROP_MS)
    .map(([id, s]) => ({ ...s, id, isQuiet: ageOf(s, nowMs) > QUIET_MS }))
    .sort((a, b) => ageOf(a, nowMs) - ageOf(b, nowMs))
}

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

export const boardPath = (root: string): string => `${slashes(root)}/docs/superpowers/board.json`

export const livePath = (root: string, hasRepo: boolean, home: string): string =>
  hasRepo ? `${slashes(root)}/.git/board-live.json` : `${slashes(home)}/.claude/board/${hash12(slashes(root))}.json`

/** 12 hex characters of FNV-1a 64 over the UTF-16 code units: a stable folder key, not a secret. */
export function hash12(s: string): string {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0').slice(0, 12)
}

export function titleOf(firstUserMessage: string | null, branch: string | null): string {
  const line = (firstUserMessage ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? ''
  if (line) return line.length > 60 ? `${line.slice(0, 59)}…` : line
  return branch || 'session'
}
