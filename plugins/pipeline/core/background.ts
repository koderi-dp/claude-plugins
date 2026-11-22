/**
 * The background shell commands of this session, as the panel lists them: what each one does, who started it and
 * for how long it has run. Pure: the hooks in register.tsx feed it and the panel draws it.
 */

import type { BgTask } from '../types'

// `id` is what TaskStop takes; `what` is the shell call's description; `owner` is `Lead` or the subagent's name.
export type { BgTask }

/** The statuses under which a task is still going; anything else has ended. */
const LIVE = new Set(['running', 'pending', 'backgrounded', 'in_progress', 'started'])
export const isLive = (status: string): boolean => LIVE.has(status.trim().toLowerCase())

const ASSIGNMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/
const CLIP = 400

/**
 * A command line as a person reads it: leading `env`, `export` and `VAR=value` words are dropped, as is a leading
 * `cd <dir> &&`, so the program that runs comes first. Whitespace is collapsed and a long line clipped.
 */
export function tidyCommand(command: string): string {
  let s = command.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 6; i++) {
    const before = s
    s = s.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '')
    s = s.replace(/^env\s+(?:-u\s+\S+\s+|-\S+\s+)*/, '')
    s = s.replace(/^export\s+/, '').replace(ASSIGNMENT, '')
    s = s.replace(/^(?:&&|;)\s*/, '')
    if (s === before) break
  }
  s = s || command.replace(/\s+/g, ' ').trim()
  return s.length > CLIP ? `${s.slice(0, CLIP)}…` : s
}

/** A path of three or more parts as its last part (`…/bbx5qjixx.output`), so a line is not mostly folders. */
export const shortPaths = (s: string): string => s.replace(/(?:[A-Za-z]:)?(?:[\\/][^\\/\s"';|&]+){3,}/g, m => `…/${m.split(/[\\/]/).pop()}`)

const LABEL = 90

/**
 * What a command does, said from the command itself, for a call that gave no description: a waiting loop is named
 * as one with what it waits for, anything else is the command with its paths shortened; one line, clipped.
 */
export function labelOf(command: string): string {
  const s = shortPaths(tidyCommand(command))
  const loop = /^(until|while)\s+(.+?)\s*;\s*do\b/.exec(s)
  const text = loop ? `Waits in a loop ${loop[1] === 'until' ? 'until' : 'while'}: ${loop[2]}` : s
  return text.length > LABEL ? `${text.slice(0, LABEL)}…` : text
}

/**
 * Whether a shell call says what it does in words a person can read: a description of two words or more that is
 * not the command itself.
 */
export function isDescribed(description: unknown, command: unknown): boolean {
  const d = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : ''
  return d.split(' ').length >= 2 && d !== String(command ?? '').replace(/\s+/g, ' ').trim()
}

/** What a background call without a description is told: the same call again, with one. */
export const NEEDS_DESCRIPTION =
  'pipeline: a background command needs a description, because the panel lists it by that. Send the same call again with `description`: one short sentence a person can read, saying what it does and what ends it (for example "Wait for the frontend build to finish; ends when the build log shows its result").'

/** A new task joins the list; one already there under the same id keeps its start. */
export function bgStart(list: BgTask[], t: { id: string; description?: string; command?: string; owner?: string; agentId?: string; at: number }): BgTask[] {
  if (!t.id || list.some(x => x.id === t.id)) return list
  const command = tidyCommand(t.command ?? '')
  const what = (t.description ?? '').replace(/\s+/g, ' ').trim() || labelOf(command) || 'a background command'
  return [...list, { id: t.id, what, command, owner: t.owner?.trim() || 'Lead', ...(t.agentId ? { agentId: t.agentId } : {}), startedAt: t.at }]
}

/** A task that ended, or was stopped, leaves the list. */
export const bgEnd = (list: BgTask[], id: string): BgTask[] => (list.some(x => x.id === id) ? list.filter(x => x.id !== id) : list)

export type BgSummary = { id: string; type: string; status: string; description?: string; command?: string }

/**
 * The list set against what the engine says is in flight (a turn's or a subagent's end names it): a task the
 * engine no longer lists has ended and goes; a shell it lists that the list does not hold yet joins it.
 */
export function bgReconcile(list: BgTask[], inFlight: readonly BgSummary[], at: number): BgTask[] {
  const live = new Set(inFlight.filter(s => isLive(s.status)).map(s => s.id))
  let out = list.filter(x => live.has(x.id))
  for (const s of inFlight) {
    if (s.type === 'shell' && isLive(s.status)) out = bgStart(out, { id: s.id, ...(s.description ? { description: s.description } : {}), ...(s.command ? { command: s.command } : {}), at })
  }
  return out.length === list.length && out.every((x, i) => x === list[i]) ? list : out
}

/** The task a task-notification prompt reports on, and how it ended; null for any other text. */
export function notificationOf(text: string): { id: string; status: string } | null {
  if (!/<task-notification>/.test(text)) return null
  const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1]
  if (!id) return null
  return { id, status: (/<status>\s*([^<]+?)\s*<\/status>/.exec(text)?.[1] ?? 'completed').toLowerCase() }
}

/** `1h 04m`, `7m 12s`, `45s`. */
export function bgClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}h ${pad(m)}m` : m ? `${m}m ${pad(s % 60)}s` : `${s}s`
}

/**
 * What Check asks the session about one task: look at it now, say where it stands, and stop it when it is stuck or
 * no longer needed, so a command that waits on nothing does not run for hours.
 */
export function checkPrompt(t: BgTask, now: number): string {
  return (
    `Check background task ${t.id} now. It has been running for ${bgClock(now - t.startedAt)}: "${t.what}"` +
    `${t.command && t.command !== t.what ? ` (\`${t.command}\`)` : ''}, started by ${t.owner}. ` +
    `Read its latest output, then answer in one or two lines which of these it is: still doing useful work (say what it waits for and roughly how long), finished, or stuck (waiting on input, a port, a server that never came up, a loop). ` +
    `If it is finished, stuck, or no longer needed by anything that is still running, stop it with TaskStop and say what that means for the work that started it; if a subagent is waiting on it, tell that subagent. Do not start it again unless the work needs it.`
  )
}
