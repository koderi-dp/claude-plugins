import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Board, NativeTask } from '../types'
import { activityOf, applyUpdate, emptyBoard, importPlan, parseBoard, serialize, statusText } from './board'
import type { ImportInput, Update } from './board'
import { boardPath } from './live'

const TOOL = 'mcp__board__board'
const DESCRIPTION = 'Show or hide the board panel; `status`, `status all`, `status <id>`, `show <id>`, `find <text>`, `init`, `open`'

const board = atom({ plugin: 'board', key: 'board' } as const, null as Board | null)
const boardError = atom({ plugin: 'board', key: 'boardError' } as const, null as string | null)
const root = atom({ plugin: 'board', key: 'root' } as const, '')
const agents = atom({ plugin: 'board', key: 'agents' } as const, [] as AgentRun[])
const tasks = atom({ plugin: 'board', key: 'tasks' } as const, [] as NativeTask[])
const now = atom({ plugin: 'board', key: 'now' } as const, 0)

const AGENT_CAP = 200

/** Whether the root is a repository's (the live file then sits in its .git). */
let hasRepo = false

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** The main checkout's root, even from a worktree; the session's root without a repository. */
async function resolveRoot($: EngineInterface): Promise<string> {
  const known = await read($, root)
  if (known) return known
  let repoRoot: string | undefined
  try {
    repoRoot = (await $.session.repo())?.root
  } catch {}
  hasRepo = Boolean(repoRoot)
  const found = slashes(repoRoot ?? (await $.session.root()))
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
  const at = await $.clock.now()
  return statusText(await read($, board), await read($, boardError), { sessions: {} }, await read($, agents), await read($, tasks), at, scope)
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
    return JSON.stringify({ exists: b !== null || error !== null, ...(error ? { error } : {}), board: b, sessions: [] })
  }
  if (error) return `refused: ${error}`
  const current = (await read($, board)) ?? emptyBoard()
  if (action === 'update') {
    const nowIso = new Date(await $.clock.now()).toISOString()
    await writeBoard($, applyUpdate(current, { goal: input.goal, milestones: input.milestones, remove: input.remove }, nowIso))
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

export const register: Register = on => {
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
    } catch {}
    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        try {
          if (!(await read($, agents)).some(a => a.status === 'running')) return
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
      }
    } catch {}
    return started
  })

  // Every call: a subagent's sets its row's activity line; the main session's
  // TaskCreate and TaskUpdate keep the native task list.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      try {
        const activity = activityOf(e as unknown as { tool: string })
        await update($, agents, list =>
          list.map(a => (a.agentId === agentId && a.status === 'running' ? { ...a, activity, calls: a.calls + 1 } : a)),
        )
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
      const [sub, ...rest] = e.args.trim().split(/\s+/)
      if (sub === 'status') {
        await loadBoard($)
        return { text: await boardText($, rest.join(' ') || undefined) }
      }
      return { text: 'board: not wired yet' }
    } catch (err) {
      return { text: `board: ${String((err as Error)?.message ?? err)}` }
    }
  })
}
