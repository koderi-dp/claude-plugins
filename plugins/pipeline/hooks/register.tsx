import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Backlog, Config, Item, Ledger, Signal } from '../types'
import { addItem, emptyBacklog, moveItem, readiness, removeItem, renderBacklogMd, updateItem } from './backlog'
import type { Readiness } from './backlog'
import { DEFAULTS } from './config'
import { parseJson, paths, serialize } from './files'
import { itemText, statusText } from './status'

const TOOL = 'mcp__pipeline__pipeline'
const DESCRIPTION = 'The pipeline: `status`, `panel`, `config`, `init`, `add`, `next`, `run`, `migrate`, `stop`, `move`, `park`, `unpark`'
const CONFIG_FILE = 'docs/pipeline/config.json'
const BACKLOG_FILE = 'docs/pipeline/backlog.json'
const BACKLOG_MD_FILE = 'docs/pipeline/BACKLOG.md'

const TOOL_DESCRIPTION =
  'The pipeline: backlog and status. Main session only; a subagent\'s call is ignored. Actions: ' +
  '`get` → JSON { config, backlog, readiness, signals }; ' +
  '`status` { id? } → the status block, or one item\'s ledger as text; ' +
  '`add` { item: { title, size, needs, source, note } } → appends an inbox item with the next id and answers `added <id>` and the status; ' +
  '`update` { id, set: { ...fields } } → merges fields into the item (status, spec, plan, branch, pr, note, needs, size, title); ' +
  '`move` { id, to: "top" | { after: "<id>" } } → reorders; ' +
  '`remove` { id }; `park` { id }; `unpark` { id }; ' +
  '`init` → writes config.json with the defaults, an empty backlog.json and BACKLOG.md when no config exists. ' +
  'Every write re-reads backlog.json, merges, regenerates BACKLOG.md and answers the status text; a file that does not parse is refused with its line and left alone.'

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['get', 'status', 'add', 'update', 'move', 'remove', 'park', 'unpark', 'init'] },
    id: { type: 'string', description: 'The item id, as p12.' },
    item: {
      type: 'object',
      description: 'For add: the new item; it starts as inbox.',
      properties: {
        title: { type: 'string' },
        size: { type: 'string', enum: ['S', 'M', 'L'] },
        needs: { type: 'array', items: { type: 'string' } },
        source: { type: 'string', description: 'Who asked and when, quoting them.' },
        note: { type: 'string' },
      },
      required: ['title'],
    },
    set: { type: 'object', description: 'For update: the fields to merge into the item.' },
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

/** The main checkout's root, even from a worktree; the session's root without a repository. */
async function resolveRoot($: EngineInterface): Promise<string> {
  let repoRoot: string | undefined
  try {
    repoRoot = (await $.session.repo())?.root
  } catch {}
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
  item?: Partial<Item> & { title?: string }
  set?: Partial<Item>
  to?: 'top' | { after: string }
}

class Refused extends Error {}

async function nowIso($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

/** The ledger of an item, when its file is on disk and parses. */
async function loadLedger($: EngineInterface, found: string, id: string): Promise<Ledger | null> {
  try {
    return (await loadJson<Ledger>($, paths(found).ledger(id), `docs/pipeline/ledgers/${id}.json`)).value
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
    if (await $.fs.exists(p.config)) return `exists: ${CONFIG_FILE}`
    await $.fs.write(p.config, serialize(DEFAULTS))
    const empty = emptyBacklog()
    await $.fs.write(p.backlog, serialize(empty))
    await $.fs.write(p.backlogMd, renderBacklogMd(empty))
    await update($, config, () => structuredClone(DEFAULTS))
    await update($, backlog, () => empty)
    await update($, fileError, () => null)
    return `wrote ${CONFIG_FILE}, ${BACKLOG_FILE}, ${BACKLOG_MD_FILE}`
  }
  if (e.action === 'status') {
    if (e.id === undefined) return statusNow($, found, c, loaded, error)
    const item = loaded?.items.find(i => i.id === e.id) ?? null
    if (!item) return `no item ${e.id}`
    const ledger = await loadLedger($, found, item.id)
    return ledger ? itemText(ledger, item) : `${[item.id, item.title, item.status].join(' · ')}\nno ledger`
  }
  if (e.action === 'get') {
    const r = loaded ? await judgeAll($, found, loaded) : {}
    const out: Record<string, unknown> = { config: c, backlog: loaded, readiness: r, signals: [] }
    if (error) out['error'] = error
    return JSON.stringify(out, null, 2)
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
    case 'add': {
      const title = e.item?.title?.trim()
      if (!title) throw new Refused('add needs item.title')
      const next = addItem(current, { ...e.item, title }, now)
      const id = next.items[next.items.length - 1]!.id
      return `added ${id}\n${await writeBacklog($, found, c, next)}`
    }
    case 'update': {
      const id = need(e.id)
      if (!e.set || typeof e.set !== 'object') throw new Refused('update needs set')
      return writeBacklog($, found, c, updateItem(current, id, e.set, now))
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
    return started
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
