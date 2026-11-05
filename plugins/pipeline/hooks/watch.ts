// The watchdog of spec §8. Pure: the agent table, the activity line, the four
// signals and the protected-path glob. Takes and returns plain data; nothing
// here imports the engine.

import type { AgentRun, Live, Signal } from '../types'

export type Call = { tool: string; [k: string]: unknown }
export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
export type Limits = { fixRounds: number; silentMinutes: number; taskMinutes: number; itemTokens: number }
export type Spawned = { id: string; agentId?: string; name: string; model: string; at: number }

/** How many agents the table keeps; the oldest finished ones go first. */
export const AGENT_CAP = 50
/** A live entry not refreshed for this long belongs to a session that is gone. */
export const STALE_MS = 3 * 60_000
const KEEP_COMMANDS = 3
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const slashes = (p: string) => p.replace(/\\/g, '/')
const basename = (p: string) => slashes(p).replace(/\/+$/, '').split('/').pop() || p
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const minutes = (ms: number) => Math.floor(ms / 60_000)

/** The file an edit tool's call names, whichever field carries it. */
export function pathOf(call: Call): string | undefined {
  const p = call['file_path'] ?? call['notebook_path'] ?? call['path']
  return typeof p === 'string' && p ? p : undefined
}

/** The command without leading env assignments (`FOO=1 npm test`), spaces collapsed, trimmed. */
export function normalizeCommand(cmd: string): string {
  return cmd
    .replace(/\s+/g, ' ')
    .replace(/(^|&&|\|\||;|\|)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `npm run check:fast` from a shell command: the first segment that is not a `cd`, its first word and up to two plain arguments. */
function commandPhrase(cmd: string): string {
  const segments = normalizeCommand(cmd)
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map(s => s.trim())
    .filter(Boolean)
  const segment = segments.find(s => !/^(cd|pushd|export|set)\b/.test(s)) ?? segments[0] ?? ''
  const words = segment.split(' ')
  const head = words[0] ?? ''
  const out = [head]
  for (const w of words.slice(1, 3)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(w)) break
    out.push(w)
  }
  return out.join(' ').slice(0, 40)
}

/** One short phrase for what a tool call does; never the raw command. */
export function activityOf(call: Call): string {
  const tool = call.tool
  if (EDIT_TOOLS.has(tool)) return `editing ${basename(pathOf(call) ?? 'a file')}`
  if (tool === 'Bash') return `running ${commandPhrase(str(call['command']))}`.trim()
  if (tool === 'Read') return `reading ${basename(pathOf(call) ?? 'a file')}`
  if (tool === 'Grep' || tool === 'Glob') return `searching "${str(call['pattern']).slice(0, 40)}"`
  if (tool === 'Agent') return 'dispatching a subagent'
  if (tool === 'WebFetch' || tool === 'WebSearch' || /browser|chrome|navigate/i.test(tool)) return 'waiting on a browser page'
  return `using ${tool}`
}

const same = (a: AgentRun, agentId: string) => a.agentId === agentId

/** A started subagent joins the table. */
export function onSpawn(agents: AgentRun[], s: Spawned): AgentRun[] {
  const run: AgentRun = {
    id: s.id,
    ...(s.agentId ? { agentId: s.agentId } : {}),
    name: s.name || 'subagent',
    model: s.model,
    status: 'running',
    startedAt: s.at,
    lastStepAt: s.at,
    calls: 0,
    tokens: 0,
    activity: 'starting',
    lastCommands: [],
    failures: 0,
  }
  const kept = [...agents, run]
  if (kept.length <= AGENT_CAP) return kept
  const finished = kept.filter(a => a.status !== 'running')
  const drop = new Set(finished.slice(0, kept.length - AGENT_CAP))
  return kept.filter(a => !drop.has(a))
}

/** A model request of the agent: the silence resets and its tokens add up. */
export function onStep(agents: AgentRun[], agentId: string, usage: Usage | null | undefined, at: number): AgentRun[] {
  const used = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0
  return agents.map(a => (same(a, agentId) && a.status === 'running' ? { ...a, lastStepAt: at, tokens: a.tokens + used } : a))
}

/** A tool call of the agent: its activity line and call count. */
export function onCall(agents: AgentRun[], agentId: string, call: Call, _at: number): AgentRun[] {
  const activity = activityOf(call)
  return agents.map(a => (same(a, agentId) && a.status === 'running' ? { ...a, activity, calls: a.calls + 1 } : a))
}

/**
 * A shell command's outcome: a failure joins the last commands (normalised,
 * three kept) and counts; a success ends the streak and resets the count.
 */
export function onResult(agents: AgentRun[], agentId: string, call: Call, isError: boolean): AgentRun[] {
  if (call.tool !== 'Bash') return agents
  const cmd = normalizeCommand(str(call['command']))
  return agents.map(a => {
    if (!same(a, agentId) || a.status !== 'running') return a
    if (!isError) return { ...a, lastCommands: [], failures: 0 }
    return { ...a, lastCommands: [...a.lastCommands, cmd].slice(-KEEP_COMMANDS), failures: a.failures + 1 }
  })
}

/** The agent's turn ended: done on an answer, failed on anything else. */
export function onComplete(agents: AgentRun[], agentId: string, reason: string, at: number): AgentRun[] {
  return agents.map(a => (same(a, agentId) && a.status === 'running' ? { ...a, status: reason === 'answer' ? 'done' : 'failed', endedAt: at } : a))
}

const keyOf = (s: Pick<Signal, 'kind' | 'agentId' | 'agent'>) => `${s.kind}\u0000${s.agentId ?? s.agent}`

/**
 * The signals to raise now: silent, looping and budget for each running agent,
 * each kind once per agent (one already in `previous` is not raised again).
 */
export function signals(agents: AgentRun[], limits: Limits, now: number, previous: Signal[]): Signal[] {
  const seen = new Set(previous.map(keyOf))
  const out: Signal[] = []
  const raise = (a: AgentRun, kind: Signal['kind'], detail: string) => {
    const s: Signal = { kind, agent: a.name, ...(a.agentId ? { agentId: a.agentId } : {}), detail, at: now, delivered: false }
    const k = keyOf(s)
    if (seen.has(k)) return
    seen.add(k)
    out.push(s)
  }
  for (const a of agents) {
    if (a.status !== 'running') continue
    if (now - a.lastStepAt >= limits.silentMinutes * 60_000) raise(a, 'silent', `no step for ${minutes(now - a.lastStepAt)} min · last: ${a.activity}`)
    const last = a.lastCommands
    if (last.length >= KEEP_COMMANDS && last.every(c => c === last[0])) raise(a, 'looping', `"${last[0]}" failed ${last.length} times in a row`)
    else if (a.failures > limits.fixRounds) raise(a, 'looping', `${a.failures} failed commands, over fixRounds ${limits.fixRounds}`)
    if (now - a.startedAt >= limits.taskMinutes * 60_000) raise(a, 'budget', `running ${minutes(now - a.startedAt)} min, over taskMinutes ${limits.taskMinutes}`)
  }
  return out
}

/**
 * Agents the live file lists as running under this session's id (a restart)
 * or under an entry no heartbeat refreshed for STALE_MS: each a dead signal,
 * with the entries they came from so the caller can drop them.
 */
export function deadAgents(live: Live, thisSessionId: string, now: number): { signals: Signal[]; sessions: string[] } {
  const out: Signal[] = []
  const sessions: string[] = []
  for (const [id, entry] of Object.entries(live.sessions)) {
    const seen = Date.parse(entry.seenAt)
    const isGone = id === thisSessionId || Number.isNaN(seen) || now - seen > STALE_MS
    if (!isGone) continue
    const running = entry.agents.filter(a => a.status === 'running')
    if (!running.length) continue
    sessions.push(id)
    for (const a of running) {
      const where = [entry.item ? `item ${entry.item}` : '', `session ${id}`, a.activity ? `last: ${a.activity}` : ''].filter(Boolean).join(' · ')
      out.push({ kind: 'dead', agent: a.name, ...(a.agentId ? { agentId: a.agentId } : {}), detail: `was running when the session ended · ${where}`, at: now, delivered: false })
    }
  }
  return { signals: out, sessions }
}

/** Whether a path matches a glob: `**` crosses directories, `*` and `?` stay within one segment. */
export function matchesGlob(path: string, glob: string): boolean {
  const p = slashes(path).replace(/\/+$/, '')
  let re = ''
  const g = slashes(glob)
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(p)
}

/** Whether the path, or the path relative to one of the roots, matches a protected glob. */
export function isProtected(path: string, globs: string[], roots: string[] = []): boolean {
  if (!globs.length) return false
  const p = slashes(path)
  const candidates = [p]
  for (const root of roots) {
    const r = slashes(root).replace(/\/+$/, '')
    if (r && p.startsWith(`${r}/`)) candidates.push(p.slice(r.length + 1))
  }
  return globs.some(g => candidates.some(c => matchesGlob(c, g)))
}
