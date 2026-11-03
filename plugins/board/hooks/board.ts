// Pure: the board file's shape, merge, plan import and the text renderer.
// Nothing here imports the engine, so the tests need none.
import type { AgentRun, Board, Goal, Item, ItemStatus, Live, LiveSession, Milestone, NativeTask } from '../types'

export type Parsed = { ok: true; board: Board } | { ok: false; error: string }

export type Update = {
  goal?: Partial<Goal>
  milestones?: Array<Omit<Partial<Milestone>, 'items'> & { id: string; after?: string; items?: Array<Partial<Item> & { id: string; after?: string }> }>
  remove?: string[]
}

export type ImportInput = { plan: string; text: string; milestone?: Partial<Milestone> & { id?: string } }
export type Imported = { ok: true; board: Board; milestoneId: string; count: number } | { ok: false; error: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------- parse ----------

/** Where JSON text first stops being JSON, as an offset; -1 when it parses. */
function jsonErrorAt(text: string): number {
  let i = 0
  const ws = () => {
    while (i < text.length && ' \t\r\n'.includes(text[i]!)) i++
  }
  const fail = (): never => {
    throw i
  }
  const value = (): void => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      ws()
      if (text[i] === '}') return void i++
      for (;;) {
        ws()
        if (text[i] !== '"') fail()
        string()
        ws()
        if (text[i] !== ':') fail()
        i++
        value()
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === '}') return void i++
        fail()
      }
    }
    if (c === '[') {
      i++
      ws()
      if (text[i] === ']') return void i++
      for (;;) {
        value()
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === ']') return void i++
        fail()
      }
    }
    if (c === '"') return string()
    const lit = /^(true|false|null|-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?)/.exec(text.slice(i, i + 64))
    if (!lit) fail()
    i += lit![0].length
  }
  const string = () => {
    i++
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\n') fail()
      i += text[i] === '\\' ? 2 : 1
    }
    if (i >= text.length) fail()
    i++
  }
  try {
    value()
    ws()
    return i < text.length ? i : -1
  } catch (at) {
    return typeof at === 'number' ? Math.min(at, text.length) : 0
  }
}

const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length

const ITEM_STATUSES = new Set(['backlog', 'next', 'in_progress', 'blocked', 'done'])
const MILESTONE_STATUSES = new Set(['planned', 'active', 'done'])

export function parseBoard(text: string): Parsed {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    const at = jsonErrorAt(text)
    const message = String((err as Error)?.message ?? err).replace(/^JSON Parse error:\s*/, '')
    return { ok: false, error: `line ${lineAt(text, at < 0 ? text.length : at)}: ${message}` }
  }
  if (!isObject(data) || !Array.isArray(data.milestones)) return { ok: false, error: 'line 1: not a board (no "milestones" list)' }
  const milestones = (data.milestones as unknown[]).filter(isObject).map(m => {
    // A hand edit can leave an item without a title or with a status no view draws.
    const items = (Array.isArray(m.items) ? (m.items as unknown[]).filter(isObject) : []).map(i => ({
      ...i,
      id: String(i.id ?? ''),
      title: String(i.title ?? i.id ?? ''),
      status: ITEM_STATUSES.has(String(i.status)) ? i.status : 'backlog',
    }))
    const status = MILESTONE_STATUSES.has(String(m.status)) ? m.status : 'planned'
    return { ...m, id: String(m.id ?? ''), title: String(m.title ?? m.id ?? ''), status, items } as Milestone
  })
  return { ok: true, board: { ...data, version: 1, milestones } as Board }
}

export const emptyBoard = (): Board => ({ version: 1, milestones: [] })

export const serialize = (board: Board): string => JSON.stringify(board, null, 2) + '\n'

// ---------- merge ----------

const defined = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

function place<T extends { id: string }>(list: T[], one: T, after: string | undefined): T[] {
  const at = after === undefined ? -1 : list.findIndex(x => x.id === after)
  if (at < 0) return [...list, one]
  return [...list.slice(0, at + 1), one, ...list.slice(at + 1)]
}

function mergeItems(items: Item[], updates: NonNullable<NonNullable<Update['milestones']>[number]['items']>, nowIso: string): Item[] {
  let list = items
  for (const u of updates) {
    const { after, ...fields } = u
    const given = defined(fields)
    const old = list.find(i => i.id === u.id)
    if (old) {
      const next = { ...old, ...given } as Item
      if (given.status !== undefined && given.status !== old.status) next.updatedAt = nowIso
      list = list.map(i => (i.id === u.id ? next : i))
    } else {
      const next = { title: u.id, status: 'backlog' as ItemStatus, ...given } as Item
      if (given.status !== undefined) next.updatedAt = nowIso
      list = place(list, next, after)
    }
  }
  return list
}

export function applyUpdate(board: Board, u: Update, nowIso: string): Board {
  const copy = JSON.parse(JSON.stringify(board)) as Board
  let milestones = copy.milestones
  for (const m of u.milestones ?? []) {
    const { after, items, ...fields } = m
    const given = defined(fields)
    const old = milestones.find(x => x.id === m.id)
    if (old) {
      const next = { ...old, ...given, items: mergeItems(old.items, items ?? [], nowIso) } as Milestone
      milestones = milestones.map(x => (x.id === m.id ? next : x))
    } else {
      const next = { title: m.id, status: 'planned', ...given, items: mergeItems([], items ?? [], nowIso) } as Milestone
      milestones = place(milestones, next, after)
    }
  }
  // A bare id names a milestone; `<milestone>/<item>` one item, since every plan has a `t3`.
  const gone = new Set(u.remove ?? [])
  if (gone.size) milestones = milestones.filter(m => !gone.has(m.id)).map(m => ({ ...m, items: m.items.filter(i => !gone.has(`${m.id}/${i.id}`)) }))
  const goal = u.goal ? ({ ...(copy.goal ?? { title: '', done: 0, total: 0 }), ...defined(u.goal) } as Goal) : copy.goal
  return { ...copy, ...(goal ? { goal } : {}), milestones }
}

// ---------- import ----------

export const anchorOf = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

const milestoneIdOf = (plan: string) =>
  (plan.split(/[\\/]/).pop() ?? plan).replace(/\.[^.]+$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '')

export function importPlan(board: Board, input: ImportInput): Imported {
  const text = input.text.replace(/\r/g, '')
  const tasks = [...text.matchAll(/^### Task (\d+):[ \t]*(.+?)[ \t]*$/gm)].map(([, n, title]) => ({
    id: `t${n}`,
    title: String(title),
    ref: `${input.plan}#${anchorOf(`Task ${n}: ${title}`)}`,
  }))
  if (!tasks.length) return { ok: false, error: `no "### Task N:" headings in ${input.plan}` }
  const { id: givenId, items: _items, ...given } = input.milestone ?? {}
  const id = givenId || milestoneIdOf(input.plan)
  const title = (given.title as string | undefined) ?? /^# (.+?)\s*$/m.exec(text)?.[1] ?? id
  const copy = JSON.parse(JSON.stringify(board)) as Board
  const old = copy.milestones.find(m => m.id === id)
  const items: Item[] = tasks.map(t => {
    const was = old?.items.find(i => i.id === t.id)
    return was ? { ...was, title: t.title, ref: t.ref } : { id: t.id, title: t.title, status: 'backlog', ref: t.ref }
  })
  const extras = old?.items.filter(i => !tasks.some(t => t.id === i.id)) ?? []
  const status = old?.status ?? (copy.milestones.length === 0 ? 'active' : 'planned')
  const next = { ...(old ?? {}), ...defined(given), id, title, status, ref: input.plan, items: [...items, ...extras] } as Milestone
  const milestones = old ? copy.milestones.map(m => (m.id === id ? next : m)) : [...copy.milestones, next]
  return { ok: true, board: { ...copy, milestones }, milestoneId: id, count: tasks.length }
}

// ---------- text ----------

export const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d`
}

export const shortModel = (model: string): string => /(fable|mythos|opus|sonnet|haiku)/i.exec(model)?.[1]?.toLowerCase() ?? model

const doneOf = (m: Milestone) => m.items.filter(i => i.status === 'done').length

export const queueText = (m: Milestone): string => [m.needs?.length ? `needs ${m.needs.join(', ')}` : '', m.size ?? ''].filter(Boolean).join(' · ')

const since = (iso: string | undefined, at: number) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? '' : elapsed(at - t)
}

export function attention(m: Milestone, live: Live, at: number = Date.now()): { kind: 'blocked' | 'in_progress' | 'next' | 'none'; count: number; text: string } {
  const blocked = m.items.filter(i => i.status === 'blocked')
  if (blocked.length) return { kind: 'blocked', count: blocked.length, text: `${blocked.length} blocked: ${blocked[0]!.note || blocked[0]!.title}` }
  const going = m.items.filter(i => i.status === 'in_progress')
  if (going.length) {
    const first = going[0]!
    const holder = Object.values(live.sessions).find(s => s.item === `${m.id}/${first.id}`)
    const agent = holder?.agents[0]
    const tail = agent ? ` · ${shortModel(agent.model)} · ${since(agent.startedAt, at)}` : ''
    return { kind: 'in_progress', count: going.length, text: `${going.length} in progress: ${first.title}${tail}` }
  }
  const next = m.items.find(i => i.status === 'next') ?? m.items.find(i => i.status === 'backlog')
  if (next) return { kind: 'next', count: 1, text: `next: ${next.title}` }
  return { kind: 'none', count: 0, text: '' }
}

const GLYPH: Record<string, string> = { active: '●', planned: '○', done: '✓', in_progress: '●', blocked: '◐', next: '○', backlog: '·' }

function milestoneRow(m: Milestone, live: Live, at: number): string {
  const parts = [`${GLYPH[m.status] ?? '○'} ${m.id} · ${m.title} · ${doneOf(m)}/${m.items.length}`]
  if (m.status === 'active') {
    const a = attention(m, live, at)
    if (a.kind !== 'none') parts.push(a.text)
  } else if (m.status === 'planned' && queueText(m)) parts.push(queueText(m))
  return parts.join(' · ')
}

function itemRow(i: Item, at: number): string {
  const parts = [`${GLYPH[i.status] ?? '·'} ${i.id} · ${i.title} · ${i.status}`]
  if ((i.status === 'in_progress' || i.status === 'blocked') && since(i.updatedAt, at)) parts.push(since(i.updatedAt, at))
  if (i.note) parts.push(i.note)
  return parts.join(' · ')
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function nowLines(live: Live, agents: AgentRun[], tasks: NativeTask[], at: number): string[] {
  const lines: string[] = []
  if (tasks.length) {
    const count = (s: NativeTask['status']) => tasks.filter(t => t.status === s).length
    const parts = [
      count('in_progress') && `${count('in_progress')} in progress`,
      count('pending') && `${count('pending')} pending`,
      count('completed') && `${count('completed')} completed`,
    ].filter(Boolean)
    lines.push(`  tasks: ${parts.join(', ')}`)
  }
  for (const a of agents.filter(a => a.status === 'running')) {
    lines.push(`  ● ${a.name} · ${shortModel(a.model)} · ${elapsed(at - a.startedAt)} · ${a.activity}`)
  }
  const finished = agents.filter(a => a.status !== 'running')
  for (const a of finished.slice(-8)) {
    lines.push(`  ${a.status === 'done' ? '✓' : '✗'} ${a.name} · ${elapsed((a.endedAt ?? at) - a.startedAt)} · ${plural(a.calls, 'call')}`)
  }
  if (finished.length > 8) lines.push(`  +${finished.length - 8} more finished`)
  for (const s of Object.values(live.sessions)) {
    const latest = s.agents[s.agents.length - 1]
    const parts = [s.title, s.branch, s.item, s.agents.length ? plural(s.agents.length, 'agent') : '', latest?.activity].filter(Boolean)
    lines.push(`  sessions: ${parts.join(' · ')}`)
  }
  if (!lines.length) lines.push('  nothing running')
  return ['Now', ...lines]
}

function headLine(board: Board | null, error: string | null): string {
  if (error) return `Board: ${error}`
  if (!board) return 'No board. /board init reads the plans and the ledger.'
  if (board.goal) return `Board · ${board.goal.title} ${board.goal.done}/${board.goal.total}`
  const items = board.milestones.flatMap(m => m.items)
  return `Board · ${items.filter(i => i.status === 'done').length}/${items.length} done`
}

/**
 * The board and Now as text: the tool's answers, `/board status`, the phone.
 * `live` here is the other sessions only; the caller leaves this one out. `own`, this session's entry, counts for the chips only.
 */
export function statusText(board: Board | null, error: string | null, live: Live, agents: AgentRun[], tasks: NativeTask[], at: number, scope?: 'all' | string, own?: LiveSession): string {
  const chips: Live = own ? { sessions: { ...live.sessions, ' self': own } } : live
  const lines = [headLine(board, error)]
  if (board && !error && scope && scope !== 'all') {
    const m = board.milestones.find(x => x.id === scope)
    if (!m) return `No milestone ${scope}. Ids: ${board.milestones.map(x => x.id).join(', ') || 'none'}`
    lines.push(milestoneRow(m, chips, at))
    const where = [m.ref, m.branch].filter(Boolean).join(' · ')
    if (where) lines.push(`  ${where}`)
    for (const i of m.items) lines.push(`  ${itemRow(i, at)}`)
    if (m.closes?.length) lines.push('Closes', ...m.closes.map(c => `  ${c}`))
    return [...lines, ...nowLines(live, agents, tasks, at)].join('\n')
  }
  if (board && !error) {
    const isAll = scope === 'all'
    const group = (status: Milestone['status']) => board.milestones.filter(m => m.status === status)
    const withItems = (m: Milestone) => [`  ${milestoneRow(m, chips, at)}`, ...(isAll ? m.items.map(i => `    ${itemRow(i, at)}`) : [])]
    const active = group('active')
    if (active.length) lines.push('Active', ...active.flatMap(withItems))
    const planned = group('planned')
    if (planned.length) {
      const shown = isAll ? planned : planned.slice(0, 4)
      lines.push('Planned', ...shown.flatMap(withItems))
      if (planned.length > shown.length) lines.push(`  … and ${planned.length - shown.length} more planned`)
    }
    const done = group('done')
    if (done.length) {
      lines.push('Done')
      if (isAll || done.length === 1) lines.push(...done.flatMap(withItems))
      else lines.push(`  ✓ ${done.length} milestones, latest: ${done[done.length - 1]!.title}`)
    }
  }
  return [...lines, ...nowLines(live, agents, tasks, at)].join('\n')
}

export function findText(board: Board, query: string): string {
  const q = query.trim().toLowerCase()
  const rows = board.milestones.flatMap(m =>
    m.items.filter(i => i.title.toLowerCase().includes(q) || (i.note ?? '').toLowerCase().includes(q)).map(i => `${m.id} · ${i.id} · ${i.title} · ${i.status}`),
  )
  return rows.length ? rows.join('\n') : `No items match "${query.trim()}".`
}

// ---------- activity line ----------

const basename = (p: unknown) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The command a shell call runs, in its first three words: env assignments, `export`, `timeout`, `time` left out. */
function commandWords(command: string): string {
  const segment = command.split(/&&|;|\|\||\n/).map(s => s.trim()).filter(s => s && !/^export\s/.test(s) && !/^cd\s/.test(s)).pop() ?? ''
  const words = (segment.split('|')[0] ?? '').trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  let i = 0
  while (i < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++
    else if (words[i] === 'time' || words[i] === 'env') i++
    else if (words[i] === 'timeout' && /^\d/.test(words[i + 1] ?? '')) i += 2
    else break
  }
  return words.slice(i, i + 3).join(' ')
}

export function activityOf(call: { tool: string; [k: string]: unknown }): string {
  const t = call.tool
  if (t === 'Edit' || t === 'Write' || t === 'NotebookEdit' || t === 'MultiEdit') return `editing ${basename(call.file_path ?? call.notebook_path)}`
  if (t === 'Read') return `reading ${basename(call.file_path)}`
  if (t === 'Grep' || t === 'Glob') return `searching "${cut(String(call.pattern ?? ''), 40)}"`
  if (t === 'Bash' || t === 'PowerShell') {
    const words = commandWords(String(call.command ?? ''))
    return words ? `running ${cut(words, 48)}` : 'running a command'
  }
  if (t === 'Agent' || t === 'Task') return `delegating ${cut(String(call.description ?? ''), 48)}`.trim()
  if (t === 'WebFetch') return `fetching ${/^[a-z]+:\/\/([^/?#]+)/i.exec(String(call.url ?? ''))?.[1] ?? 'a page'}`
  if (t === 'WebSearch') return `fetching ${cut(String(call.query ?? ''), 48)}`
  if (/^mcp__.*(browser|playwright)/i.test(t)) return 'waiting on a browser page'
  if (/^Task(Create|Update|List|Get)$/.test(t) || t === 'TodoWrite') return 'updating tasks'
  return `using ${t.replace(/^mcp__/, '')}`
}
