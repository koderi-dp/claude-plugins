// The session runner: each item in its own headless Claude Code child, started
// from the parent's session in the item's worktree. Pure: the argument vector,
// the child's prompt, the reading of its output, the child record's lifecycle
// and the parent's watchdog over children. The engine calls live in register.tsx.

import type { Backlog, ChildSession, Item, Live, Signal } from '../types'

/** The permission modes a headless child can run in: it cannot ask, so the parent's mode must answer for it. */
export const ALLOWED_MODES = ['acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const
/** The log a child record carries is cut back to LOG_KEEP characters once it passes LOG_CAP. */
export const LOG_CAP = 256 * 1024
export const LOG_KEEP = 200 * 1024
/** How many lines `log` answers. */
export const TAIL_LINES = 60
const DROPPED = '… earlier output dropped …\n'
const TOOL = 'mcp__pipeline__pipeline'

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

export type ChildArgvInput = { prompt: string; permissionMode: string; sessionId?: string; /** The child's display name, `p12 · CSV export`. */ name?: string }

/**
 * `claude -p` in the item's worktree: the parent's permission mode, since the child cannot ask (anything that
 * would prompt is denied), its events as JSON lines so the log reads along, and the session id the parent
 * chose, so the child's live entry is found by it. No plugin flag: a child started on the same machine loads
 * the installed plugins as the parent did.
 */
/** Appended to a child's system prompt: nobody reads a headless run as it goes, and every word between calls is paid for. */
export const CHILD_SYSTEM = 'This is a headless run nobody watches live. Write no text between tool calls: after a tool result, the next thing you emit is the next tool call. Your only text is the one closing line the pipeline-run skill asks for.'

export function childArgv({ prompt, permissionMode, sessionId, name }: ChildArgvInput): string[] {
  return ['claude', '-p', prompt, '--permission-mode', permissionMode, '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', CHILD_SYSTEM, ...(sessionId ? ['--session-id', sessionId] : []), ...(name ? ['--name', name] : [])]
}

/** What the child is told: the item, the skill, that the parent already set the status and made the worktree it runs in. */
export function childPrompt(item: string, options: { isResume?: boolean } = {}): string {
  const head = options.isResume
    ? `Resume item ${item} with the pipeline-run skill (its resume.md), as runner subagent whatever the config says, from where its ledger's resume block says to merge.`
    : `Run item ${item} with the pipeline-run skill, as runner subagent whatever the config says, from begin to merge.`
  return (
    `${head} The worktree is this directory, on the item's branch: never run EnterWorktree, never create another worktree, never change directory. ` +
    `The session runner already set ${item} to building (its note says so). ` +
    `First tool call: ${TOOL} {"action":"begin","item":"${item}"}, which answers where the item stands; then the plan, or the resume it names. Answer one line per turn; a stop condition sets the item blocked with the reason and ends this run.`
  )
}

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const firstLine = (s: string) => s.split('\n').map(l => l.trim()).find(Boolean) ?? ''

/** The one argument of a tool use worth a log line: the command, the file, the description or the first string. */
function toolArgument(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  for (const key of ['command', 'file_path', 'notebook_path', 'path', 'description', 'pattern', 'skill', 'url']) {
    const v = input[key]
    if (typeof v === 'string' && v) return firstLine(v)
  }
  const any = Object.values(input).find(v => typeof v === 'string' && v)
  return typeof any === 'string' ? firstLine(any) : ''
}

/**
 * One line of the child's output as a human reads it: a stream-json event becomes its text and tool uses,
 * a result its verdict, turns and cost; system noise and tool results give nothing; other text passes through.
 */
export function parseChildLine(line: string): string | null {
  const t = line.trim()
  if (!t) return null
  if (!t.startsWith('{')) return t
  let ev: Record<string, unknown>
  try {
    ev = JSON.parse(t) as Record<string, unknown>
  } catch {
    return t
  }
  if (!ev || typeof ev !== 'object') return t
  const type = str(ev['type'])
  if (type === 'system') return str(ev['subtype']) === 'init' ? 'session started' : null
  if (type === 'assistant') {
    const message = ev['message'] as { content?: unknown } | undefined
    const blocks = Array.isArray(message?.content) ? (message.content as Block[]) : []
    const lines: string[] = []
    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim()) lines.push(firstLine(b.text))
      else if (b.type === 'tool_use') lines.push(['→', str(b.name) || 'tool', toolArgument(b.input)].filter(Boolean).join(' '))
    }
    return lines.length ? lines.join('\n') : null
  }
  if (type === 'result') {
    const subtype = str(ev['subtype'])
    const text = str(ev['result'])
    const turns = typeof ev['num_turns'] === 'number' ? `${ev['num_turns']} turns` : ''
    const cost = typeof ev['total_cost_usd'] === 'number' ? `$${ev['total_cost_usd'].toFixed(2)}` : ''
    return ['result:', subtype === 'success' && text ? firstLine(text) : subtype || 'ended', turns, cost].filter(Boolean).join(' · ').replace('result: ·', 'result:')
  }
  return null
}

/** The child record with a piece of output read: complete lines go into the log as readable lines, the rest waits. */
export function appendOutput(child: ChildSession, text: string, partial: string): { child: ChildSession; partial: string } {
  const whole = partial + text
  const parts = whole.split('\n')
  const rest = parts.pop() ?? ''
  const lines = parts.map(parseChildLine).filter((l): l is string => l !== null)
  if (!lines.length) return { child, partial: rest }
  let log = child.log + lines.join('\n') + '\n'
  if (log.length > LOG_CAP) log = DROPPED + log.slice(log.length - LOG_KEEP).replace(/^[^\n]*\n/, '')
  const last = lines[lines.length - 1]!
  return { child: { ...child, log, lastLine: last.split('\n').pop() ?? last }, partial: rest }
}

const hasEnded = (c: ChildSession) => c.status === 'stopped' || c.status === 'finished' || c.status === 'failed'

/** The child record once its process ended: finished on code 0, failed on another code, stopped by a signal. */
export function withExit(child: ChildSession, end: { code: number | null; signal: string | null }, at: number): ChildSession {
  if (hasEnded(child)) return child
  const status = end.code === 0 ? 'finished' : end.code === null ? 'stopped' : 'failed'
  return { ...child, status, endedAt: at }
}

/** The child record once the person stopped it; a child that already ended keeps its end. */
export function withStopped(child: ChildSession, at: number): ChildSession {
  return hasEnded(child) ? child : { ...child, status: 'stopped', endedAt: at }
}

/** The children whose process runs: starting or running. */
export const runningOf = (children: ChildSession[]): ChildSession[] => children.filter(c => !hasEnded(c))

/** The last `n` lines of a log, without the trailing newline. */
export function tail(log: string, n = TAIL_LINES): string {
  const lines = log.replace(/\n$/, '').split('\n')
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

/** The note a non-zero exit leaves on the item: the code and the last three lines of the log. */
export function exitNote(child: ChildSession, end: { code: number | null; signal: string | null }): string {
  const last = tail(child.log, 3).split('\n').filter(Boolean).join(' · ')
  if (end.code === null) return `child ended by ${end.signal ?? 'a signal'}${last ? `: ${last}` : ''}`
  return `child exited with code ${end.code}${last ? `: ${last}` : ''}`
}

/** The items `run all` may start now: ready, every need merged, no child in flight for them, up to the free slots. */
export function startable(backlog: Backlog, children: ChildSession[], parallel: number): Item[] {
  const running = runningOf(children)
  const free = Math.max(0, parallel - running.length)
  if (!free) return []
  const merged = new Set(backlog.items.filter(i => i.status === 'merged').map(i => i.id))
  const inFlight = new Set(running.map(c => c.item))
  return backlog.items.filter(i => i.status === 'ready' && !inFlight.has(i.id) && (i.needs ?? []).every(n => merged.has(n))).slice(0, free)
}

/**
 * The parent's watch over its children: a running child whose live entry is stale (or still missing past the
 * stale limit) is silent; a child whose process ended while its item is still building is dead. Each signal
 * once: the caller merges by kind and agent.
 */
export function childSignals(args: { children: ChildSession[]; live: Live; items: Item[]; now: number; staleMs: number }): Signal[] {
  const { children, live, items, now, staleMs } = args
  const out: Signal[] = []
  for (const c of children) {
    const agent = `child ${c.item}`
    if (!hasEnded(c)) {
      const entry = live.sessions[c.id]
      const seen = entry ? Date.parse(entry.seenAt) : NaN
      const since = Number.isNaN(seen) ? c.startedAt : seen
      const age = now - since
      if (age > staleMs) out.push({ kind: 'silent', agent, agentId: c.id, detail: `no heartbeat from the child session for ${Math.floor(age / 60_000)} min while its process runs`, at: now, delivered: false })
      continue
    }
    const item = items.find(i => i.id === c.item)
    if (item?.status === 'building') out.push({ kind: 'dead', agent, agentId: c.id, detail: `the child session exited with ${c.item} still building · resume with /pipeline run ${c.item}`, at: now, delivered: false })
  }
  return out
}

/** The worktree of an item under the main checkout. */
export const worktreeOf = (root: string, id: string): string => `${slashes(root)}/.claude/worktrees/${id}`

/** The branch of an item from the config's template; a template without `<id>` gets the id as a last segment. */
export const branchOf = (template: string, id: string): string => (template.includes('<id>') ? template.replaceAll('<id>', id) : `${template.replace(/\/+$/, '')}/${id}`)
