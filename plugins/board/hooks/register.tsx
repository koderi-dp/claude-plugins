import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Board, Live, LiveSession, NativeTask, Panel } from '../types'
import { renderNow } from './pane'
import { activityOf, applyUpdate, emptyBoard, importPlan, parseBoard, serialize, statusText } from './board'
import type { ImportInput, Update } from './board'
import { boardPath, livePath, others, parseLive, titleOf, withEntry, withoutEntry } from './live'
import type { Others } from './live'

const TOOL = 'mcp__board__board'
const DESCRIPTION = 'Show or hide the board panel; `status`, `status all`, `status <id>`, `show <id>`, `find <text>`, `init`, `open`'

const board = atom({ plugin: 'board', key: 'board' } as const, null as Board | null)
const boardError = atom({ plugin: 'board', key: 'boardError' } as const, null as string | null)
const root = atom({ plugin: 'board', key: 'root' } as const, '')
const agents = atom({ plugin: 'board', key: 'agents' } as const, [] as AgentRun[])
const tasks = atom({ plugin: 'board', key: 'tasks' } as const, [] as NativeTask[])
const now = atom({ plugin: 'board', key: 'now' } as const, 0)
const live = atom({ plugin: 'board', key: 'live' } as const, { sessions: {} } as Live)
const panel = atom({ plugin: 'board', key: 'panel' } as const, { view: { kind: 'home' }, isMoreShown: false, autoOpenedFor: '' } as Panel)

const PANE = 'board'
const USAGE = 'board: status | status all | status <id> | show <id> | find <text> | init | open'

/** The `autoOpen` setting as this load of the module received it. */
let isAutoOpen = true

async function openPane($: EngineInterface): Promise<void> {
  await update($, now, () => 0)
  await $.ui.open({ id: PANE, title: 'Board' })
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    return false
  }
}

async function togglePane($: EngineInterface): Promise<boolean> {
  if (await isPaneOpen($)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await openPane($)
  return true
}

/** Opens the panel by itself, once per reason (`board`, `agents`), unless the setting says never. */
async function autoOpen($: EngineInterface, reason: string): Promise<void> {
  if (!isAutoOpen) return
  const p = await read($, panel)
  if (p.autoOpenedFor.split(',').includes(reason)) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: [prev.autoOpenedFor, reason].filter(Boolean).join(',') }))
  void $.ui.open({ id: PANE, title: 'Board' })
}

const AGENT_CAP = 200

/** The root as resolved by this load of the module, and whether it is a repository's. */
let resolved: { root: string; hasRepo: boolean } | null = null

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** The main checkout's root, even from a worktree; the session's root without a repository. */
async function resolveRoot($: EngineInterface): Promise<string> {
  if (resolved) return resolved.root
  let repoRoot: string | undefined
  try {
    repoRoot = (await $.session.repo())?.root
  } catch {}
  const found = slashes(repoRoot ?? (await $.session.root()))
  resolved = { root: found, hasRepo: Boolean(repoRoot) }
  await update($, root, () => found)
  return found
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    const t = await $.fs.read(path)
    return typeof t === 'string' ? t : null
  } catch {
    return null
  }
}

/** Reads the board file: missing gives null and no error, bad JSON gives the error. */
async function loadBoard($: EngineInterface): Promise<void> {
  const text = await readText($, boardPath(await resolveRoot($)))
  if (text === null) {
    await update($, board, () => null)
    await update($, boardError, () => null)
    return
  }
  const parsed = parseBoard(text)
  await update($, board, prev => (parsed.ok ? parsed.board : prev))
  await update($, boardError, () => (parsed.ok ? null : parsed.error))
}

// `$.fs` has no rename, so the file is written once at its own path; the
// re-read before each write keeps another session's changes.
async function writeBoard($: EngineInterface, next: Board): Promise<void> {
  await $.fs.write(boardPath(await resolveRoot($)), serialize(next))
  await loadBoard($)
}

async function boardText($: EngineInterface, scope?: string): Promise<string> {
  const others = await othersNow($)
  const at = await $.clock.now()
  return statusText(await read($, board), await read($, boardError), asLive(others), await read($, agents), await read($, tasks), at, scope)
}

// ---------- the live file: this session's entry, and the others' ----------

const HEARTBEAT_MS = 2000
const READ_MS = 5000

/** This session's own facts for its entry; the module's, so a reload starts them over from the file. */
const self = { firstPrompt: null as string | null, branch: undefined as string | undefined, item: undefined as string | undefined, startedAt: '', lastWrite: -Infinity, lastRead: -Infinity }

async function homeDir($: EngineInterface): Promise<string> {
  // `$.env.get` takes a literal name, so the module's reads can be listed.
  let v: string | undefined
  try {
    v = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  } catch {}
  return v ? slashes(v) : ''
}

async function liveFile($: EngineInterface): Promise<string> {
  const r = await resolveRoot($)
  return livePath(r, resolved?.hasRepo ?? false, await homeDir($))
}

/** The branch the session's own checkout is on: `.git` is a folder in a main checkout, a `gitdir:` file in a worktree. */
async function branchOf($: EngineInterface): Promise<string | undefined> {
  try {
    const top = slashes(await $.session.root())
    const pointer = await readText($, `${top}/.git`)
    const gitDir = pointer?.startsWith('gitdir:') ? slashes(pointer.slice(7).trim()) : `${top}/.git`
    const head = await readText($, `${gitDir}/HEAD`)
    return /^ref: refs\/heads\/(.+?)\s*$/m.exec(head ?? '')?.[1]
  } catch {
    return undefined
  }
}

async function sessionId($: EngineInterface): Promise<string> {
  return $.session.id()
}

async function entryOf($: EngineInterface, previous: LiveSession | undefined, nowMs: number): Promise<LiveSession> {
  const nowIso = new Date(nowMs).toISOString()
  if (!self.startedAt) self.startedAt = previous?.startedAt || nowIso
  if (self.item === undefined && previous?.item) self.item = previous.item
  const running = (await read($, agents)).filter(a => a.status === 'running')
  let cwd = ''
  try {
    cwd = slashes(await $.session.cwd())
  } catch {}
  return {
    title: titleOf(self.firstPrompt, self.branch ?? null),
    cwd,
    ...(self.branch ? { branch: self.branch } : {}),
    ...(self.item ? { item: self.item } : {}),
    startedAt: self.startedAt,
    seenAt: nowIso,
    agents: running.map(a => ({ name: a.name, model: a.model, startedAt: new Date(a.startedAt).toISOString(), activity: a.activity })),
  }
}

/**
 * Writes this session's entry after a fresh read, so another session's write
 * in the same second survives. Throttled to one write per 2 s unless `isForced`.
 */
async function heartbeat($: EngineInterface, isForced = false): Promise<void> {
  try {
    const at = await $.clock.now()
    if (!isForced && at - self.lastWrite < HEARTBEAT_MS) return
    self.lastWrite = at
    const path = await liveFile($)
    const id = await sessionId($)
    const current = parseLive((await readText($, path)) ?? '')
    const next = withEntry(current, id, await entryOf($, current.sessions[id], at), at)
    await $.fs.write(path, JSON.stringify(next, null, 2) + '\n')
    self.lastRead = at
    await update($, live, () => next)
  } catch {}
}

/** Reads the live file at most every 5 s; answers what this session last saw. */
async function readLive($: EngineInterface): Promise<Live> {
  try {
    const at = await $.clock.now()
    if (at - self.lastRead >= READ_MS) {
      self.lastRead = at
      const next = parseLive((await readText($, await liveFile($))) ?? '')
      await update($, live, () => next)
      return next
    }
  } catch {}
  return read($, live)
}

async function othersNow($: EngineInterface): Promise<Others> {
  const l = await readLive($)
  return others(l, await sessionId($), await $.clock.now())
}

const asLive = (list: Others): Live => ({ sessions: Object.fromEntries(list.map(({ id, isQuiet: _q, ...s }) => [id, s])) })

async function leave($: EngineInterface): Promise<void> {
  try {
    const path = await liveFile($)
    const current = parseLive((await readText($, path)) ?? '')
    await $.fs.write(path, JSON.stringify(withoutEntry(current, await sessionId($)), null, 2) + '\n')
  } catch {}
}

// ---------- agents and the native task list ----------

const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed'])

/** The id the engine gave a task, from its answer (`Task #3 created …`), else the next number. */
function taskIdOf(result: unknown, list: NativeTask[]): string {
  let text = ''
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result)
  } catch {}
  return /#(\d+)/.exec(text)?.[1] ?? String(list.length + 1)
}

async function onTaskCall($: EngineInterface, e: { tool: string; [k: string]: unknown }, result: unknown): Promise<void> {
  if (e.tool === 'TaskCreate') {
    const subject = String(e.subject ?? '').trim()
    if (!subject) return
    await update($, tasks, list => [...list, { id: taskIdOf((result as { result?: unknown })?.result ?? result, list), subject, status: 'pending' as const }].slice(-100))
    return
  }
  if (e.tool === 'TaskUpdate') {
    const id = String(e.taskId ?? '')
    const status = String(e.status ?? '')
    const subject = typeof e.subject === 'string' ? e.subject.trim() : ''
    await update($, tasks, list => {
      const at = list.findIndex(t => t.id === id)
      if (at < 0) return list
      if (status === 'deleted') return list.filter((_, i) => i !== at)
      return list.map((t, i) => (i === at ? { ...t, ...(TASK_STATUSES.has(status) ? { status: status as NativeTask['status'] } : {}), ...(subject ? { subject } : {}) } : t))
    })
  }
}

type ToolInput = Update & { action?: string; plan?: string; milestone?: ImportInput['milestone'] }

async function runTool($: EngineInterface, input: ToolInput): Promise<string> {
  const action = input.action ?? 'get'
  await loadBoard($)
  const error = await read($, boardError)
  if (action === 'get') {
    const b = await read($, board)
    return JSON.stringify({ exists: b !== null || error !== null, ...(error ? { error } : {}), board: b, sessions: await othersNow($) })
  }
  if (error) return `refused: ${error}`
  const current = (await read($, board)) ?? emptyBoard()
  if (action === 'update') {
    const nowIso = new Date(await $.clock.now()).toISOString()
    await writeBoard($, applyUpdate(current, { goal: input.goal, milestones: input.milestones, remove: input.remove }, nowIso))
    // The item this session now works on goes into its live entry.
    const taken = (input.milestones ?? []).flatMap(m => (m.items ?? []).filter(i => i.status === 'in_progress').map(i => `${m.id}/${i.id}`)).pop()
    if (taken) {
      self.item = taken
      await heartbeat($, true)
    }
    return boardText($)
  }
  if (action === 'import') {
    const plan = String(input.plan ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
    if (!plan) return 'refused: import needs `plan`, a repo-relative path'
    const text = await readText($, `${await resolveRoot($)}/${plan}`)
    if (text === null) return `refused: cannot read ${plan}`
    const r = importPlan(current, { plan, text, milestone: input.milestone })
    if (!r.ok) return `refused: ${r.error}`
    await writeBoard($, r.board)
    return `imported ${r.count} tasks into ${r.milestoneId}\n${await boardText($)}`
  }
  return `refused: unknown action ${action}; use get, update or import`
}

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['get', 'update', 'import'] },
    goal: {
      type: 'object',
      description: 'The one line above the overview, replaced whole.',
      properties: { title: { type: 'string' }, done: { type: 'integer' }, total: { type: 'integer' } },
    },
    milestones: {
      type: 'array',
      description: 'Milestones to add or change, matched by id; fields left out keep their value.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string', enum: ['planned', 'active', 'done'] },
          ref: { type: 'string' },
          branch: { type: 'string' },
          needs: { type: 'array', items: { type: 'string' } },
          size: { type: 'string', enum: ['S', 'M', 'L'] },
          closes: { type: 'array', items: { type: 'string' } },
          after: { type: 'string', description: 'Place a new milestone right after this id.' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string', enum: ['backlog', 'next', 'in_progress', 'blocked', 'done'] },
                note: { type: 'string', description: 'One line: where the status came from, or what blocks it.' },
                ref: { type: 'string' },
                after: { type: 'string' },
              },
              required: ['id'],
            },
          },
        },
        required: ['id'],
      },
    },
    remove: { type: 'array', items: { type: 'string' }, description: 'Milestone or item ids to drop.' },
    plan: { type: 'string', description: 'For import: the plan file, relative to the repository root.' },
    milestone: {
      type: 'object',
      description: 'For import: the milestone fields to set (id, title, needs, size, closes, branch).',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        branch: { type: 'string' },
        needs: { type: 'array', items: { type: 'string' } },
        size: { type: 'string', enum: ['S', 'M', 'L'] },
        closes: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  required: ['action'],
}

export const register: Register = (on, options) => {
  isAutoOpen = (options as Record<string, unknown> | undefined)?.autoOpen !== 'never'
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({ name: 'board', description: DESCRIPTION })
      await $.tool.register({
        name: 'board',
        description:
          'The project board: `get` reads it; `update` upserts milestones and items by id (fields left out keep their value; `remove` drops ids); ' +
          '`import` reads a plan\'s `### Task N:` headings into a milestone. Main session only.',
        isDeferred: false,
        inputSchema: TOOL_SCHEMA,
      })
      await resolveRoot($)
      await loadBoard($)
      self.branch = await branchOf($)
      await heartbeat($, true)
      if (await read($, board)) await autoOpen($, 'board')
    } catch {}
    // Keeps this session's live entry fresh while it lives.
    $.clock.every(30_000, () => void heartbeat($, true))
    // Ticks the running agents' clocks, and the other sessions while the panel is open.
    $.clock.every(1000, () => {
      void (async () => {
        try {
          const isRunning = (await read($, agents)).some(a => a.status === 'running')
          const isOpen = await isPaneOpen($)
          if (isOpen) await readLive($)
          if (!isRunning && !isOpen) return
          const at = await $.clock.now()
          await update($, now, () => at)
        } catch {}
      })()
    })
    return started
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    try {
      if (started && 'model' in started && typeof started.model === 'string') {
        const at = await $.clock.now()
        const run: AgentRun = {
          id: started.agentId ?? e.tool_use_id,
          ...(started.agentId ? { agentId: started.agentId } : {}),
          name: e.description || 'subagent',
          model: started.model,
          status: 'running',
          startedAt: at,
          calls: 0,
          activity: 'starting',
        }
        await update($, agents, list => [...list, run].slice(-AGENT_CAP))
        await update($, now, () => at)
        await heartbeat($, true)
        await autoOpen($, 'agents')
      }
    } catch {}
    return started
  })

  // The session's title in the live file is its first prompt.
  on('prompt.submit', async ($, e, next) => {
    if (self.firstPrompt === null && e.text.trim() && !e.text.trim().startsWith('/')) self.firstPrompt = e.text
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await leave($)
    return next(e)
  })

  // Every call: a subagent's sets its row's activity line; the main session's
  // TaskCreate and TaskUpdate keep the native task list.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      try {
        const activity = activityOf(e as unknown as { tool: string })
        let isChanged = false
        await update($, agents, list =>
          list.map(a => {
            if (a.agentId !== agentId || a.status !== 'running') return a
            isChanged ||= a.activity !== activity
            return { ...a, activity, calls: a.calls + 1 }
          }),
        )
        if (isChanged) void heartbeat($)
      } catch {}
      return next(e)
    }
    const result = await next(e)
    if (e.tool === 'TaskCreate' || e.tool === 'TaskUpdate') {
      try {
        await onTaskCall($, e as unknown as { tool: string }, result)
      } catch {}
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      try {
        const at = await $.clock.now()
        await update($, agents, list =>
          list.map(a => (a.agentId === agentId && a.status === 'running' ? { ...a, status: e.reason === 'answer' ? 'done' : 'failed', endedAt: at } : a)),
        )
        await update($, now, () => at)
      } catch {}
    }
    await heartbeat($, true)
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId) return { result: 'ignored: subagents do not write the board' }
    try {
      return { result: await runTool($, e as unknown as ToolInput) }
    } catch (err) {
      return { result: `refused: ${String((err as Error)?.message ?? err)}` }
    }
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    try {
      const [sub = '', ...rest] = e.args.trim().split(/\s+/)
      const arg = rest.join(' ')
      if (sub === '') {
        const isOpen = await togglePane($)
        return { text: isOpen ? 'Board panel opened.' : 'Board panel closed.' }
      }
      if (sub === 'open') {
        await openPane($)
        return { text: 'Board panel opened.' }
      }
      if (sub === 'status') {
        await loadBoard($)
        return { text: await boardText($, arg || undefined) }
      }
      return { text: USAGE }
    } catch (err) {
      return { text: `board: ${String((err as Error)?.message ?? err)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const at = Math.max(await read($, now), await $.clock.now())
    const l = await read($, live)
    let selfId = ''
    try {
      selfId = await sessionId($)
    } catch {}
    return renderNow(ui, { agents: await read($, agents), tasks: await read($, tasks), others: others(l, selfId, at), at })
  })
}
