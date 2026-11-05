import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Backlog, Config, Item, Ledger, LiveEntry, Signal } from '../types'
import { addItem, emptyBacklog, moveItem, readiness, removeItem, renderBacklogMd, updateItem } from './backlog'
import type { Readiness } from './backlog'
import { DEFAULTS } from './config'
import { hashRoot, livePath, parseJson, paths, serialize } from './files'
import { ledgerText, mergeLedger, emptyLedger } from './ledger'
import type { LedgerSet } from './ledger'
import { parseLive, withEntry, withoutEntry } from './live'
import { statusText } from './status'
import { deadAgents, isProtected, onCall, onComplete, onResult, onSpawn, onStep, pathOf, signals as raiseSignals } from './watch'
import type { Call, Limits } from './watch'

const TOOL = 'mcp__pipeline__pipeline'
const DESCRIPTION = 'The pipeline: `status`, `panel`, `config`, `init`, `add`, `next`, `run`, `migrate`, `stop`, `move`, `park`, `unpark`'
const CONFIG_FILE = 'docs/pipeline/config.json'
const BACKLOG_FILE = 'docs/pipeline/backlog.json'
const BACKLOG_MD_FILE = 'docs/pipeline/BACKLOG.md'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TICK_MS = 30_000
const HEARTBEAT_MS = 2000
const WAKE_PROMPT = 'pipeline: check the watchdog signals with the pipeline tool'
const ACTIVE_STATUSES = ['planning', 'building', 'review'] as const

const TOOL_DESCRIPTION =
  'The pipeline: backlog and status. Main session only; a subagent\'s call is ignored. Actions: ' +
  '`get` → JSON { config, backlog, readiness, active, resume, signals }: the active item, its ledger\'s resume block and the open watchdog signals (silent, dead, looping, budget), each delivered once; ' +
  '`status` { id? } → the status block, or one item\'s ledger as text; ' +
  '`add` { item: { title, size, needs, source, note } } → appends an inbox item with the next id and answers `added <id>` and the status; ' +
  '`update` { id, set: { ...fields } } → merges fields into the item (status, spec, plan, branch, pr, note, needs, size, title); ' +
  '`move` { id, to: "top" | { after: "<id>" } } → reorders; ' +
  '`remove` { id }; `park` { id }; `unpark` { id }; ' +
  '`ledger` { item: "<id>", set: { tasks?: [{ n, title?, status?, commits?, dispatches?: [{ role, model, effort, tokens, minutes, result, risky? }], review? }], rulings?: [{ task?, text, why, costIfWrong }], resume?: { task, state, lastVerified? }, final?: { verdict, gate?, tokens?, findings? }, blockers?: [..], pr?, branch?, worktree?, base?, plan? } } ' +
  '→ merges into docs/pipeline/ledgers/<id>.json (tasks by n with dispatches appended, rulings appended and numbered, blockers appended, tokens recomputed), creates it and links it from the item when missing, mirrors branch, pr and plan onto the item, and answers the ledger as text; ' +
  '`init` → writes config.json with the defaults, an empty backlog.json and BACKLOG.md when no config exists. ' +
  'Every write re-reads backlog.json, merges, regenerates BACKLOG.md and answers the status text; a file that does not parse is refused with its line and left alone.'

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['get', 'status', 'add', 'update', 'move', 'remove', 'park', 'unpark', 'ledger', 'init'] },
    id: { type: 'string', description: 'The item id, as p12.' },
    item: {
      type: ['object', 'string'],
      description: 'For add: the new item; it starts as inbox. For ledger: the item id, as p12.',
      properties: {
        title: { type: 'string' },
        size: { type: 'string', enum: ['S', 'M', 'L'] },
        needs: { type: 'array', items: { type: 'string' } },
        source: { type: 'string', description: 'Who asked and when, quoting them.' },
        note: { type: 'string' },
      },
      required: ['title'],
    },
    set: { type: 'object', description: 'For update: the fields to merge into the item. For ledger: the fields to merge into the ledger.' },
    to: { description: 'For move: "top" or { after: "<id>" }.' },
  },
  required: ['action'],
}

const root = atom({ plugin: 'pipeline', key: 'root' } as const, '')
const config = atom({ plugin: 'pipeline', key: 'config' } as const, null as Config | null)
const backlog = atom({ plugin: 'pipeline', key: 'backlog' } as const, null as Backlog | null)
const fileError = atom({ plugin: 'pipeline', key: 'fileError' } as const, null as string | null)
const agents = atom({ plugin: 'pipeline', key: 'agents' } as const, [] as AgentRun[])
const signals = atom({ plugin: 'pipeline', key: 'signals' } as const, [] as Signal[])

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// What this module instance knows between hooks: the live file's whereabouts,
// this session's entry, the heartbeat throttle, the pending wake-up and the ticker.
const self = {
  hasRepo: false,
  sessionRoot: '',
  startedAt: '',
  lastWrite: -Infinity,
  wakeUntil: -Infinity,
  ticker: null as null | { cancel: () => void },
}

/** The main checkout's root, even from a worktree; the session's root without a repository. */
async function resolveRoot($: EngineInterface): Promise<string> {
  let repoRoot: string | undefined
  try {
    repoRoot = (await $.session.repo())?.root
  } catch {}
  self.hasRepo = Boolean(repoRoot)
  const found = slashes(repoRoot ?? (await $.session.root()))
  await update($, root, () => found)
  return found
}

/** The 1-based line a JSON parse error names, from its line or its position; 1 when it gives neither. */
export function errorLine(text: string, message: string): number {
  const line = /line (\d+)/i.exec(message)
  if (line) return Number(line[1])
  const pos = /position (\d+)/i.exec(message)
  if (pos) return text.slice(0, Number(pos[1])).split('\n').length
  return 1
}

type Loaded<T> = { value: T | null; error: string | null }

/** Reads a JSON file: missing gives null and no error, bad JSON gives the error with its line. */
async function loadJson<T>($: EngineInterface, path: string, file: string): Promise<Loaded<T>> {
  if (!(await $.fs.exists(path))) return { value: null, error: null }
  const text = await $.fs.read(path)
  const parsed = parseJson<T>(typeof text === 'string' ? text : '', file)
  return parsed.ok ? { value: parsed.value, error: null } : { value: null, error: parsed.error }
}

/** Reads the config file into its atoms. */
async function loadConfig($: EngineInterface, found: string): Promise<Loaded<Config>> {
  const loaded = await loadJson<Config>($, paths(found).config, CONFIG_FILE)
  await update($, config, () => loaded.value)
  return loaded
}

/** Reads the backlog file into its atom. */
async function loadBacklog($: EngineInterface, found: string): Promise<Loaded<Backlog>> {
  const loaded = await loadJson<Backlog>($, paths(found).backlog, BACKLOG_FILE)
  await update($, backlog, () => loaded.value)
  return loaded
}

/** Reads both files; `fileError` is the first error, the config's before the backlog's. */
async function loadAll($: EngineInterface, found: string): Promise<{ config: Config | null; backlog: Backlog | null; error: string | null }> {
  const c = await loadConfig($, found)
  const b = await loadBacklog($, found)
  const error = c.error ?? b.error
  await update($, fileError, () => error)
  return { config: c.value, backlog: b.value, error }
}

// ---------- readiness from the files ----------

/** Whether the text after a `## Open` heading has a line that is neither empty nor italic. */
export function hasOpenQuestion(spec: string): boolean {
  const m = /^##\s+Open\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(spec)
  if (!m) return false
  return m[1]!.split('\n').some(l => {
    const t = l.trim()
    return t !== '' && !/^[_*].*[_*]$/.test(t)
  })
}

/** The readiness of every inbox or ready item, with the spec looked up on disk. */
async function judgeAll($: EngineInterface, found: string, b: Backlog): Promise<Record<string, Readiness>> {
  const p = paths(found)
  const exists = new Map<string, boolean>()
  const open = new Map<string, boolean>()
  for (const item of b.items) {
    if (item.status !== 'inbox' && item.status !== 'ready') continue
    const specPath = item.spec ? `${found}/${slashes(item.spec).replace(/^\//, '')}` : p.spec(item.id)
    let there = false
    try {
      there = await $.fs.exists(specPath)
    } catch {}
    exists.set(item.id, there)
    if (!there) continue
    try {
      const text = await $.fs.read(specPath)
      open.set(item.id, hasOpenQuestion(typeof text === 'string' ? text : ''))
    } catch {
      open.set(item.id, false)
    }
  }
  return readiness({ backlog: b, specExists: i => exists.get(i.id) ?? false, specHasOpen: i => open.get(i.id) ?? false })
}

/** Inbox items that are ready become `ready`; ready items that no longer are go back to `inbox`. */
function settle(b: Backlog, r: Record<string, Readiness>, now: string): Backlog {
  let out = b
  for (const item of b.items) {
    const judged = r[item.id]
    if (!judged) continue
    if (item.status === 'inbox' && judged.ready) out = updateItem(out, item.id, { status: 'ready' }, now)
    else if (item.status === 'ready' && !judged.ready) out = updateItem(out, item.id, { status: 'inbox' }, now)
  }
  return out
}

// ---------- the tool ----------

type ToolInput = {
  action: string
  id?: string
  item?: (Partial<Item> & { title?: string }) | string
  set?: Partial<Item> | LedgerSet
  to?: 'top' | { after: string }
}

class Refused extends Error {}

async function nowIso($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

const ledgerFile = (id: string) => `docs/pipeline/ledgers/${id}.json`

/** The ledger of an item as it is on disk: missing gives null, bad JSON gives the error with its line. */
async function readLedger($: EngineInterface, found: string, id: string): Promise<Loaded<Ledger>> {
  return loadJson<Ledger>($, paths(found).ledger(id), ledgerFile(id))
}

/** The ledger of an item, when its file is on disk and parses. */
async function loadLedger($: EngineInterface, found: string, id: string): Promise<Ledger | null> {
  try {
    return (await readLedger($, found, id)).value
  } catch {
    return null
  }
}

async function statusNow($: EngineInterface, found: string, c: Config | null, b: Backlog | null, error: string | null): Promise<string> {
  const active = b?.items.find(i => i.status === 'planning' || i.status === 'building' || i.status === 'review') ?? null
  return statusText({
    config: c,
    backlog: b,
    readiness: b ? await judgeAll($, found, b) : {},
    ledger: active ? await loadLedger($, found, active.id) : null,
    agents: await read($, agents),
    signals: await read($, signals),
    now: await $.clock.now(),
    fileError: error,
  })
}

/** Writes the backlog and its generated view, refreshes the atom and answers the status. */
async function writeBacklog($: EngineInterface, found: string, c: Config | null, next: Backlog): Promise<string> {
  const p = paths(found)
  const settled = settle(next, await judgeAll($, found, next), await nowIso($))
  await $.fs.write(p.backlog, serialize(settled))
  await $.fs.write(p.backlogMd, renderBacklogMd(settled))
  await update($, backlog, () => settled)
  await update($, fileError, () => null)
  return statusNow($, found, c, settled, null)
}

async function runTool($: EngineInterface, e: ToolInput): Promise<string> {
  const found = await resolveRoot($)
  const { config: c, backlog: loaded, error } = await loadAll($, found)
  const p = paths(found)

  if (e.action === 'init') {
    const hasConfig = await $.fs.exists(p.config)
    const hasBacklog = await $.fs.exists(p.backlog)
    if (hasConfig && hasBacklog) return `exists: ${CONFIG_FILE}`
    const wrote: string[] = []
    if (!hasConfig) {
      await $.fs.write(p.config, serialize(DEFAULTS))
      await update($, config, () => structuredClone(DEFAULTS))
      wrote.push(CONFIG_FILE)
    }
    if (!hasBacklog) {
      const empty = emptyBacklog()
      await $.fs.write(p.backlog, serialize(empty))
      await $.fs.write(p.backlogMd, renderBacklogMd(empty))
      await update($, backlog, () => empty)
      wrote.push(BACKLOG_FILE, BACKLOG_MD_FILE)
    }
    await update($, fileError, () => null)
    return `wrote ${wrote.join(', ')}`
  }
  if (e.action === 'status') {
    if (e.id === undefined) return statusNow($, found, c, loaded, error)
    const item = loaded?.items.find(i => i.id === e.id) ?? null
    if (!item) return `no item ${e.id}`
    const ledger = await readLedger($, found, item.id)
    if (ledger.error) return `${[item.id, item.title, item.status].join(' · ')}\n${ledger.error}`
    return ledger.value ? ledgerText(ledger.value, item) : `${[item.id, item.title, item.status].join(' · ')}\nno ledger`
  }
  if (e.action === 'get') {
    const r = loaded ? await judgeAll($, found, loaded) : {}
    const open = (await read($, signals)).filter(s => !s.delivered)
    const active = loaded?.items.find(i => i.status === 'building' || i.status === 'review') ?? null
    const ledger = active ? await loadLedger($, found, active.id) : null
    const out: Record<string, unknown> = { config: c, backlog: loaded, readiness: r, active: active?.id ?? null, resume: ledger?.resume ?? null, signals: open }
    if (error) out['error'] = error
    const answer = JSON.stringify(out, null, 2)
    // Each signal is delivered once: what this answer carries is marked.
    if (open.length) {
      await update($, signals, list => list.map(s => (s.delivered ? s : { ...s, delivered: true })))
      await heartbeat($, true)
    }
    return answer
  }

  // Every write: the file as it is on disk, or refused when it does not parse.
  if (error) throw new Refused(error)
  const current = loaded ?? emptyBacklog()
  const now = await nowIso($)
  const need = (id: string | undefined): string => {
    if (!id) throw new Refused('an id is needed')
    if (!current.items.some(i => i.id === id)) throw new Refused(`no item ${id}`)
    return id
  }
  switch (e.action) {
    case 'ledger': {
      const id = need(typeof e.item === 'string' ? e.item : e.item?.id)
      const set = e.set as LedgerSet | undefined
      if (!set || typeof set !== 'object' || Array.isArray(set)) throw new Refused('ledger needs set')
      const onDisk = await readLedger($, found, id)
      if (onDisk.error) throw new Refused(onDisk.error)
      const merged = mergeLedger(onDisk.value ?? emptyLedger(id), set, now)
      await $.fs.write(p.ledger(id), serialize(merged))
      // The item points at its ledger, and carries the branch, PR and plan the ledger names.
      const item = current.items.find(i => i.id === id)!
      const mirror: Partial<Item> = {}
      if (item.ledger !== ledgerFile(id)) mirror.ledger = ledgerFile(id)
      for (const k of ['branch', 'pr', 'plan'] as const) if (typeof set[k] === 'string' && item[k] !== set[k]) mirror[k] = set[k] as string
      if (Object.keys(mirror).length) await writeBacklog($, found, c, updateItem(current, id, mirror, now))
      return ledgerText(merged, { ...item, ...mirror })
    }
    case 'add': {
      const title = typeof e.item === 'string' ? undefined : e.item?.title?.trim()
      if (!title) throw new Refused('add needs item.title')
      const next = addItem(current, { ...(e.item as Partial<Item>), title }, now)
      const id = next.items[next.items.length - 1]!.id
      return `added ${id}\n${await writeBacklog($, found, c, next)}`
    }
    case 'update': {
      const id = need(e.id)
      if (!e.set || typeof e.set !== 'object') throw new Refused('update needs set')
      return writeBacklog($, found, c, updateItem(current, id, e.set as Partial<Item>, now))
    }
    case 'move': {
      const id = need(e.id)
      const to = e.to
      if (to !== 'top' && !(to && typeof to === 'object' && typeof to.after === 'string')) throw new Refused('move needs to: "top" or { after: "<id>" }')
      if (to !== 'top') need(to.after)
      return writeBacklog($, found, c, moveItem(current, id, to))
    }
    case 'remove':
      return writeBacklog($, found, c, removeItem(current, need(e.id)))
    case 'park':
      return writeBacklog($, found, c, updateItem(current, need(e.id), { status: 'parked' }, now))
    case 'unpark':
      return writeBacklog($, found, c, updateItem(current, need(e.id), { status: 'inbox' }, now))
    default:
      throw new Refused(`unknown action "${String(e.action)}"`)
  }
}

// ---------- the watchdog and the live file ----------

/** The limits in force: the config's over the defaults, so a partial config still has every number. */
function limitsOf(c: Config | null): Limits {
  const given = c && typeof c.limits === 'object' && c.limits ? c.limits : {}
  const out = { ...DEFAULTS.limits }
  for (const k of Object.keys(out) as (keyof Limits)[]) {
    const v = (given as Partial<Limits>)[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
  }
  return out
}

const protectedOf = (c: Config | null): string[] => (Array.isArray(c?.protectedPaths) ? c.protectedPaths.filter((g): g is string => typeof g === 'string' && g !== '') : DEFAULTS.protectedPaths)

async function homeDir($: EngineInterface): Promise<string> {
  // `$.env.get` takes a literal name, so the module's reads can be listed.
  let v: string | undefined
  try {
    v = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  } catch {}
  return v ? slashes(v) : ''
}

async function liveFile($: EngineInterface): Promise<string> {
  const found = (await read($, root)) || (await resolveRoot($))
  return livePath(found, self.hasRepo, self.hasRepo ? '' : await homeDir($), self.hasRepo ? '' : await hashRoot(found))
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    const t = await $.fs.read(path)
    return typeof t === 'string' ? t : null
  } catch {
    return null
  }
}

/** The branch the session's own checkout is on: `.git` is a folder in a main checkout, a `gitdir:` file in a worktree. */
async function branchOf($: EngineInterface): Promise<string | undefined> {
  try {
    const top = self.sessionRoot || slashes(await $.session.root())
    const pointer = await readText($, `${top}/.git`)
    const gitDir = pointer?.startsWith('gitdir:') ? slashes(pointer.slice(7).trim()) : `${top}/.git`
    const head = await readText($, `${gitDir}/HEAD`)
    return /^ref: refs\/heads\/(.+?)\s*$/m.exec(head ?? '')?.[1]
  } catch {
    return undefined
  }
}

const activeItem = (b: Backlog | null): Item | null => b?.items.find(i => (ACTIVE_STATUSES as readonly string[]).includes(i.status)) ?? null

/** This session's live entry: the active item, the running agents and every signal of this session. */
async function entryOf($: EngineInterface, previous: LiveEntry | undefined, at: number): Promise<LiveEntry> {
  const nowIso = new Date(at).toISOString()
  if (!self.startedAt) self.startedAt = nowIso
  const item = activeItem(await read($, backlog))
  const running = (await read($, agents)).filter(a => a.status === 'running')
  let cwd = ''
  try {
    cwd = slashes(await $.session.cwd())
  } catch {}
  const branch = await branchOf($)
  const title = item ? `${item.id} · ${item.title}` : cwd.split('/').pop() || 'pipeline'
  // Unknown fields of the entry on disk survive; branch and item are this write's.
  const { branch: _b, item: _i, ...kept } = previous ?? {}
  return {
    ...kept,
    title,
    cwd,
    ...(branch ? { branch } : {}),
    ...(item ? { item: item.id } : {}),
    startedAt: self.startedAt,
    seenAt: nowIso,
    agents: running,
    signals: await read($, signals),
  }
}

/** Writes this session's entry after a fresh read of the file, throttled to one write per 2 s unless forced. */
async function heartbeat($: EngineInterface, isForced = false): Promise<void> {
  try {
    const at = await $.clock.now()
    if (!isForced && at - self.lastWrite < HEARTBEAT_MS) return
    self.lastWrite = at
    const path = await liveFile($)
    const id = await $.session.id()
    const current = parseLive((await readText($, path)) ?? '')
    await $.fs.write(path, serialize(withEntry(current, id, await entryOf($, current.sessions[id], at), at)))
  } catch {}
}

/** A signal to the person, per `config.notify`: a push notification, or a toast when the push is refused. */
async function notify($: EngineInterface, c: Config | null, list: Signal[]): Promise<void> {
  const mode = c?.notify ?? DEFAULTS.notify
  if (mode === 'off') return
  for (const s of list) {
    const message = `pipeline: ${s.kind} · ${s.agent} · ${s.detail}`.slice(0, 200)
    let isSent = false
    try {
      const r = await $.tool.call({ tool: 'PushNotification', message, status: 'proactive' })
      isSent = !(r && typeof r === 'object' && 'deny' in r && r.deny !== undefined)
    } catch {}
    if (!isSent) {
      try {
        await $.ui.toast(message)
      } catch {}
    }
  }
}

/** Every 30 s: the signals due now join the atom and reach the person; the live file is refreshed. */
async function tick($: EngineInterface): Promise<void> {
  try {
    const at = await $.clock.now()
    const c = await read($, config)
    const fresh = raiseSignals(await read($, agents), limitsOf(c), at, await read($, signals))
    if (fresh.length) {
      await update($, signals, list => [...list, ...fresh])
      await notify($, c, fresh)
    }
    await heartbeat($, true)
  } catch {}
}

/**
 * At session start: agents the live file lists running under this session's id or
 * a stale entry are dead; then this session's fresh entry, and the ticker.
 */
async function arrive($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  const path = await liveFile($)
  const id = await $.session.id()
  let current = parseLive((await readText($, path)) ?? '')
  const dead = deadAgents(current, id, at)
  // Nothing that ran before this start is still running.
  await update($, agents, list => list.map(a => (a.status === 'running' ? { ...a, status: 'failed', endedAt: at } : a)))
  if (dead.signals.length) {
    await update($, signals, list => [...list, ...dead.signals])
    for (const gone of dead.sessions) current = withoutEntry(current, gone)
    await notify($, await read($, config), dead.signals)
  }
  self.startedAt = new Date(at).toISOString()
  self.lastWrite = at
  await $.fs.write(path, serialize(withEntry(current, id, await entryOf($, undefined, at), at)))
  self.ticker?.cancel()
  self.ticker = $.clock.every(TICK_MS, () => void tick($))
}

/** Between items: one wake-up at `silentMinutes` while an agent runs, where the host offers ScheduleWakeup; never two pending. */
async function scheduleWake($: EngineInterface, at: number): Promise<void> {
  if (at < self.wakeUntil) return
  if (!(await read($, agents)).some(a => a.status === 'running')) return
  let isOffered = false
  try {
    isOffered = (await $.tool.list()).some(t => t.name === 'ScheduleWakeup')
  } catch {}
  if (!isOffered) return
  const delaySeconds = limitsOf(await read($, config)).silentMinutes * 60
  self.wakeUntil = at + delaySeconds * 1000
  try {
    await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds, reason: 'pipeline: a subagent is running; the watchdog signals are checked at silentMinutes', prompt: WAKE_PROMPT, noop: true })
  } catch {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Each step on its own, so a refused registration never keeps the files from loading.
    try {
      await $.command.register({ name: 'pipeline', description: DESCRIPTION, argumentHint: 'subcommand' })
    } catch {}
    try {
      await $.tool.register({ name: 'pipeline', description: TOOL_DESCRIPTION, isDeferred: false, inputSchema: TOOL_SCHEMA })
    } catch {}
    try {
      await loadAll($, await resolveRoot($))
    } catch {}
    try {
      self.sessionRoot = slashes(await $.session.root())
    } catch {}
    try {
      await arrive($)
    } catch {}
    return started
  })

  on('session.end', async ($, e, next) => {
    try {
      const path = await liveFile($)
      const current = parseLive((await readText($, path)) ?? '')
      await $.fs.write(path, serialize(withoutEntry(current, await $.session.id())))
    } catch {}
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    try {
      if (started && started.deny === undefined && typeof started.model === 'string') {
        const at = await $.clock.now()
        await update($, agents, list => onSpawn(list, { id: started.agentId ?? e.tool_use_id, ...(started.agentId ? { agentId: started.agentId } : {}), name: e.description, model: started.model, at }))
        await heartbeat($, true)
      }
    } catch {}
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    if (agentId) {
      try {
        const at = await $.clock.now()
        await update($, agents, list => onStep(list, agentId, result.usage, at))
      } catch {}
    }
    return result
  })

  // A subagent's call: a protected path is refused before it runs; otherwise its
  // activity line, and for a shell command whether it failed. The main session's passes.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId) return next(e)
    const call = e as unknown as Call
    try {
      if (EDIT_TOOLS.has(e.tool)) {
        const path = pathOf(call)
        if (path && isProtected(path, protectedOf(await read($, config)), [await read($, root), self.sessionRoot])) {
          return { deny: `pipeline: ${path} is protected by ${CONFIG_FILE} protectedPaths` }
        }
      }
      const at = await $.clock.now()
      await update($, agents, list => onCall(list, agentId, call, at))
      void heartbeat($)
    } catch {}
    const result = await next(e)
    if (e.tool === 'Bash') {
      try {
        const isError = Boolean(result && typeof result === 'object' && 'isError' in result && result.isError)
        await update($, agents, list => onResult(list, agentId, call, isError))
      } catch {}
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    try {
      const at = await $.clock.now()
      const agentId = e.agentId
      if (agentId) await update($, agents, list => onComplete(list, agentId, e.reason, at))
      await heartbeat($, true)
      if (!agentId) await scheduleWake($, at)
    } catch {}
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId) return { result: 'ignored: subagents do not write the pipeline' }
    try {
      return { result: await runTool($, e as unknown as ToolInput) }
    } catch (err) {
      return { result: `refused: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('command.run', { command: 'pipeline' }, async () => {
    try {
      return { text: 'pipeline: not built yet' }
    } catch {
      return { text: 'pipeline: failed' }
    }
  })
}
