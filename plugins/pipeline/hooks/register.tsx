import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { AgentRun, Backlog, Config, Item, Ledger, LiveEntry, Panel, Signal } from '../types'
import { addItem, emptyBacklog, moveItem, readiness, removeItem, renderBacklogMd, updateItem } from './backlog'
import type { Readiness } from './backlog'
import { cleanList, planOf } from './clean'
import { DEFAULTS, normalizeConfig } from './config'
import { hashRoot, livePath, parseJson, paths, serialize } from './files'
import { ledgerText, mergeLedger, emptyLedger } from './ledger'
import type { LedgerSet } from './ledger'
import { parseLive, withEntry, withoutEntry } from './live'
import { BAR_ROW_H, barSvg, barText, modelName } from './draw'
import type { Bar } from './draw'
import { BLOCKED, RUNNING, activeTitle, renderPanel } from './pane'
import { statusText } from './status'
import type { StatusInput } from './status'
import { deadAgents, isProtected, onCall, onComplete, onResult, onSpawn, onStep, pathOf, signals as raiseSignals } from './watch'
import type { Call, Limits } from './watch'

const TOOL = 'mcp__pipeline__pipeline'
const PANE = 'pipeline'
const DESCRIPTION = 'The pipeline: `status`, `panel`, `config`, `init`, `add`, `next`, `run`, `migrate`, `stop`, `move`, `park`, `unpark`, `clean`'
const USAGE =
  'pipeline: status [id] | panel | config [key=value] | init | add <text> | next | run <id> | run all | migrate | stop | move <id> top | move <id> after <id> | park <id> | unpark <id> | clean'
const CONFIG_KEYS = ['mainBranch', 'branch', 'checks', 'riskyPaths', 'protectedPaths', 'models', 'limits', 'merge', 'mergeMethod', 'stop', 'afterMerge', 'retain', 'notify']
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
  '`init` → writes config.json with the defaults, an empty backlog.json and BACKLOG.md when no config exists; ' +
  '`clean` { item? } → the repo-relative paths config.retain says may go, one per line (a merged item\'s ledgers/<id>/ unless retain.briefs, its plan unless retain.plans, its .superpowers/sdd/ folders unless retain.superpowers, its worktree under .claude/worktrees/), for one merged item or for every merged item; it deletes nothing, the caller removes them with git rm -r and commits. ' +
  'Every write re-reads backlog.json, merges, regenerates BACKLOG.md and answers the status text; a file that does not parse is refused with its line and left alone.'

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['get', 'status', 'add', 'update', 'move', 'remove', 'park', 'unpark', 'ledger', 'init', 'clean'] },
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
const panel = atom({ plugin: 'pipeline', key: 'panel' } as const, { isMoreShown: false, isCompact: false, isDoneCollapsed: false, autoOpenedFor: '' } as Panel)
// The clock the panel draws against: the ticker moves it, so minutes and the merged week stay current.
const now = atom({ plugin: 'pipeline', key: 'now' } as const, 0)

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// ---------- the panel ----------

/** The `autoOpen` setting as this load of the module received it. */
let isAutoOpen = true

async function openPane($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: 'Pipeline' })
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

/** Opens the panel by itself, once per reason, unless the setting says never. */
async function autoOpen($: EngineInterface, reason: string): Promise<void> {
  if (!isAutoOpen) return
  const p = await read($, panel)
  if (p.autoOpenedFor.split(',').includes(reason)) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: [prev.autoOpenedFor, reason].filter(Boolean).join(',') }))
  try {
    await openPane($)
  } catch {}
}

// ---------- prompts the commands hand the model ----------

const call = (input: Record<string, unknown>) => `${TOOL} ${JSON.stringify(input)}`

const INTAKE_PROMPT = (text: string) =>
  `Use the pipeline-intake skill for this request: "${text}". First tool call: ${call({ action: 'get' })} (the duplicate check). Then add the item and write its spec as the skill says, and answer in one line. Never start the build.`

const RUN_PROMPT = (target: string) =>
  `Use the pipeline-run skill. First tool call: ${call({ action: 'get' })}. Then ${target === 'all' ? 'run ready items until none is left' : target ? `run item ${target}` : 'run the first ready item'} as the skill says, from pick to merge, one line per turn.`

const MIGRATE_PROMPT = `Use the pipeline-migrate skill. First tool call: ${call({ action: 'migrate' })}, which reads the project's queue, workflow prose and ledgers and drafts the config, the rules and the items without writing. Then finish the mapping, ask once, and apply as the skill says.`

const INIT_PROMPT =
  `Set the pipeline up in this project, under the pipeline-rules skill. If the project already has a queue, a workflow document or a ledger (docs/backlog.md, an "MVP queue" in CLAUDE.md, docs/WORKFLOW.md, .superpowers/sdd/**/progress.md), use the pipeline-migrate skill instead; its first tool call is ${call({ action: 'migrate' })}. ` +
  `Otherwise the first tool call is ${call({ action: 'init' })}, which writes docs/pipeline/config.json with the defaults and an empty backlog. Then fill checks from the project's scripts and CI through /pipeline config, and answer the status text in one line.`

const STOP_PROMPT =
  `Pipeline stop, under the pipeline-run skill. First tool call: ${call({ action: 'get' })} for the active item and its resume block. Finish the task that is running: let a dispatched subagent finish or stop it at a safe point, start no other task. ` +
  `Leave the branch pushed and the ledger current: record where to resume with ${call({ action: 'ledger', item: '<id>', set: { resume: { task: '<n>', state: 'stopped by the user: <where>', lastVerified: '<sha>' } } })} as the last tool call. Then answer one line and stop.`

const CLEAN_PROMPT =
  `Pipeline clean, under the pipeline-rules skill. First tool call: ${call({ action: 'clean' })}. It lists, one per line, the paths config.retain says may go for every merged item, the superpowers folders of merged plans and the worktrees of merged items, and deletes nothing. ` +
  'From the main checkout on mainBranch: remove each listed path with `git rm -r -q` (plain `rm -r` for an untracked one; `git worktree remove` for a worktree), commit the removals on mainBranch with the attribution lines this session was given and no model identifier, and answer one line with the counts, as `cleaned: 3 folders, 1 plan, 1 worktree`. An answer of `nothing to clean` is the one line, and nothing is committed.'

const QUEUE_PROMPT = (input: Record<string, unknown>) => `Under the pipeline-rules skill, make this one tool call: ${call(input)}. It answers the status text; answer its first line and nothing else.`

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

/** Everything the status text and the panel draw from, for the files as given. */
async function gather($: EngineInterface, found: string, c: Config | null, b: Backlog | null, error: string | null): Promise<StatusInput> {
  const active = b?.items.find(i => i.status === 'planning' || i.status === 'building' || i.status === 'review') ?? null
  return {
    config: c,
    backlog: b,
    readiness: b ? await judgeAll($, found, b) : {},
    ledger: active ? await loadLedger($, found, active.id) : null,
    agents: await read($, agents),
    signals: await read($, signals),
    now: await $.clock.now(),
    fileError: error,
  }
}

async function statusNow($: EngineInterface, found: string, c: Config | null, b: Backlog | null, error: string | null): Promise<string> {
  return statusText(await gather($, found, c, b, error))
}

/** The names under a folder, with a slash after each directory; nothing when the folder is not there. */
async function listDir($: EngineInterface, dir: string): Promise<string[]> {
  try {
    if (!(await $.fs.exists(dir))) return []
    return (await $.fs.list(dir)).map(e => (e.kind === 'dir' ? `${e.name}/` : e.name))
  } catch {
    return []
  }
}

/** The listing `cleanList` wants: the known parents, the superpowers pointers and the worktree names. */
async function cleanInput($: EngineInterface, found: string, b: Backlog | null): Promise<{ listing: string[]; planPaths: Record<string, string>; worktrees: string[] }> {
  const listing: string[] = []
  for (const parent of ['docs/pipeline/ledgers', 'docs/pipeline/plans', '.superpowers/sdd', '.claude/worktrees']) {
    for (const name of await listDir($, `${found}/${parent}`)) listing.push(`${parent}/${name}`)
  }
  const planPaths: Record<string, string> = {}
  for (const entry of listing.filter(p => p.startsWith('.superpowers/sdd/') && p.endsWith('/'))) {
    const dir = entry.slice('.superpowers/sdd/'.length, -1)
    const texts: string[] = []
    for (const file of ['plan-path', 'progress.md']) {
      const t = await readText($, `${found}/${entry}${file}`)
      if (t) texts.push(t)
    }
    if (texts.length) planPaths[dir] = texts.join('\n')
  }
  // A plan kept outside docs/pipeline/plans is listed when it is there.
  for (const item of b?.items ?? []) {
    if (item.status !== 'merged') continue
    const plan = planOf(item)
    if (!plan.startsWith('docs/pipeline/plans/') && (await readText($, `${found}/${plan}`)) !== null) listing.push(plan)
  }
  const worktrees = listing.filter(p => p.startsWith('.claude/worktrees/') && p.endsWith('/')).map(p => p.slice('.claude/worktrees/'.length, -1))
  return { listing, planPaths, worktrees }
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
  if (e.action === 'clean') {
    if (error) throw new Refused(error)
    const id = typeof e.item === 'string' ? e.item : e.item?.id ?? e.id
    if (id !== undefined) {
      const item = loaded?.items.find(i => i.id === id)
      if (!item) throw new Refused(`no item ${id}`)
      if (item.status !== 'merged') throw new Refused(`${id} is ${item.status}, not merged`)
    }
    const list = cleanList({ config: c, backlog: loaded, ...(id !== undefined ? { item: id } : {}), ...(await cleanInput($, found, loaded)) })
    return list.length ? list.join('\n') : 'nothing to clean'
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
    await update($, now, () => at)
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

export const register: Register = (on, options) => {
  isAutoOpen = (options as Record<string, unknown> | undefined)?.autoOpen !== 'never'

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
        await autoOpen($, 'agents')
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

  on('command.run', { command: 'pipeline' }, async ($, e) => {
    try {
      return await runCommand($, e.args)
    } catch (err) {
      return { text: `pipeline: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    try {
      return await drawPane($, ui, e)
    } catch (err) {
      const { Text } = ui as unknown as { Text: (p: Record<string, unknown>) => RenderElement }
      return <Text color={BLOCKED}>{`pipeline: ${err instanceof Error ? err.message : String(err)}`}</Text>
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let bar: Bar | null = null
    try {
      if (!e.props.hasSurvey) bar = await barOf($)
    } catch {}
    if (!bar) return next(e)
    // The engine's own placeholder ({ type: 'engine' }) is never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const other = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const cols = e.props.bodyColumns || 100
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const width = Math.max(180, Math.min(1600, cols * 8 - 40))
      return (
        <Box flexDirection="column">
          <Svg source={barSvg(bar, width)} alt={`${bar.title}: ${bar.text}`} width={width} height={BAR_ROW_H} />
          {other}
        </Box>
      )
    }
    const width = Math.max(6, Math.min(30, cols - bar.text.length - 12))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={RUNNING}>{barText(bar, width)}</Text>
          <Text bold>{bar.text}</Text>
        </Box>
        {other}
      </Box>
    )
  })
}

// ---------- the commands ----------

type CommandAnswer = { text?: string; context?: readonly string[] }

const ID = /^[a-z][a-z0-9-]*$/i

/** `/pipeline <sub> ...`: text for what the mod answers itself, a prompt for what the model does. */
async function runCommand($: EngineInterface, args: string): Promise<CommandAnswer> {
  const [sub = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const arg = rest.join(' ')
  const prompt = (text: string, context: string): CommandAnswer => ({ text, context: [context] })
  switch (sub) {
    case 'status':
      return { text: await runTool($, { action: 'status', ...(arg ? { id: arg } : {}) }) }
    case 'panel': {
      const isOpen = await togglePane($)
      return { text: isOpen ? 'Pipeline panel opened.' : 'Pipeline panel closed.' }
    }
    case 'config':
      return { text: await configCommand($, arg) }
    case 'init':
      return prompt('pipeline: setting up…', INIT_PROMPT)
    case 'migrate':
      return prompt('pipeline: migrating…', MIGRATE_PROMPT)
    case 'add':
      if (!arg) return { text: 'pipeline: add needs the request, as /pipeline add <text>' }
      return prompt(`pipeline: intake of "${arg}"…`, INTAKE_PROMPT(arg))
    case 'next':
      return prompt('pipeline: running the first ready item…', RUN_PROMPT(''))
    case 'run':
      if (!arg || (arg !== 'all' && !ID.test(arg))) return { text: 'pipeline: run needs an id or all, as /pipeline run p12' }
      return prompt(arg === 'all' ? 'pipeline: running until nothing is ready…' : `pipeline: running ${arg}…`, RUN_PROMPT(arg))
    case 'stop':
      return prompt('pipeline: stopping after the running task…', STOP_PROMPT)
    case 'clean':
      return prompt('pipeline: cleaning…', CLEAN_PROMPT)
    case 'move': {
      const [id = '', where = '', after = ''] = rest
      const to = where === 'top' ? 'top' : where === 'after' && ID.test(after) ? { after } : null
      if (!ID.test(id) || !to) return { text: 'pipeline: move needs an id and a place, as /pipeline move p12 top or /pipeline move p12 after p9' }
      return prompt(`pipeline: moving ${id}…`, QUEUE_PROMPT({ action: 'move', id, to }))
    }
    case 'park':
    case 'unpark':
      if (!ID.test(arg)) return { text: `pipeline: ${sub} needs an id, as /pipeline ${sub} p12` }
      return prompt(`pipeline: ${sub === 'park' ? 'parking' : 'unparking'} ${arg}…`, QUEUE_PROMPT({ action: sub, id: arg }))
    default:
      return { text: USAGE }
  }
}

/** `true`, `false` and numbers as themselves, a JSON array or object as parsed, anything else as text. */
export function parseValue(raw: string): unknown {
  const v = raw.trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  if (/^[[{]/.test(v)) {
    try {
      return JSON.parse(v)
    } catch {}
  }
  return v
}

/** Sets a dotted key in a copy of the object, making the objects on the way. */
export function setPath(obj: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const [head, ...tail] = key.split('.')
  if (!head) return obj
  if (!tail.length) return { ...obj, [head]: value }
  const inner = obj[head]
  return { ...obj, [head]: setPath(inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {}, tail.join('.'), value) }
}

/** `/pipeline config`: the config file as text; `key=value` sets one key once `normalizeConfig` accepts the result. */
async function configCommand($: EngineInterface, arg: string): Promise<string> {
  const found = await resolveRoot($)
  const p = paths(found)
  const text = await readText($, p.config)
  if (text === null) return 'pipeline: no config (run /pipeline init)'
  const parsed = parseJson<Record<string, unknown>>(text, CONFIG_FILE)
  if (!parsed.ok) return `pipeline: ${parsed.error}`
  if (!arg) return text.replace(/\n$/, '')
  const m = /^([A-Za-z][\w.]*)=([\s\S]*)$/.exec(arg)
  if (!m) return 'pipeline: config takes key=value, as /pipeline config merge=pr or limits.fixRounds=4'
  const key = m[1]!
  const raw = m[2]!
  const top = key.split('.')[0]!
  if (!CONFIG_KEYS.includes(top)) return `refused: no config key ${top}; the keys are ${CONFIG_KEYS.join(', ')}`
  const value = parseValue(raw)
  const current = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value : {}
  const next = setPath(current, key, value)
  const { problems } = normalizeConfig(next)
  if (problems.length) return `refused: ${problems.join('; ')}`
  await $.fs.write(p.config, serialize(next))
  await loadConfig($, found)
  await update($, fileError, () => null)
  return `${key} = ${JSON.stringify(value)}`
}

async function drawPane($: EngineInterface, ui: ReturnType<EngineInterface['ui']['resolve']>, e: { surface: string; props: { bodyColumns?: number } }): Promise<RenderElement> {
  const found = (await read($, root)) || (await resolveRoot($))
  const c = await read($, config)
  const d = await gather($, found, c, await read($, backlog), await read($, fileError))
  const p = await read($, panel)
  const flip = (key: 'isMoreShown' | 'isCompact' | 'isDoneCollapsed') => () => void update($, panel, prev => ({ ...prev, [key]: !prev[key] }))
  return renderPanel(ui, {
    ...d,
    now: Math.max(d.now, await read($, now)),
    surface: e.surface,
    hasSvg: 'Svg' in ui,
    bodyColumns: e.props.bodyColumns ?? 40,
    isMoreShown: p.isMoreShown,
    isCompact: p.isCompact,
    isDoneCollapsed: p.isDoneCollapsed,
    limitMs: limitsOf(c).taskMinutes * 60_000,
    onMore: flip('isMoreShown'),
    onCompact: flip('isCompact'),
    onDone: flip('isDoneCollapsed'),
  })
}

/** The band above the prompt while an item is building: its line and a bar of accepted tasks over the total; nothing otherwise. */
async function barOf($: EngineInterface): Promise<Bar | null> {
  const b = await read($, backlog)
  const active = b?.items.find(i => i.status === 'building')
  if (!active) return null
  const found = (await read($, root)) || (await resolveRoot($))
  const ledger = await loadLedger($, found, active.id)
  const tasks = ledger?.tasks ?? []
  const done = tasks.filter(t => t.status === 'accepted').length
  const running = tasks.filter(t => t.status === 'running' || t.status === 'fix').length
  const at = Math.max(await read($, now), await $.clock.now())
  const agent = (await read($, agents)).find(a => a.status === 'running')
  const minutes = agent ? Math.max(0, Math.round((at - agent.startedAt) / 60_000)) : 0
  const text = [activeTitle({ backlog: b, ledger }), agent ? `${agent.name} · ${modelName(agent.model)} · ${minutes} min` : ''].filter(Boolean).join(' · ')
  return { title: active.id, text, done, running, total: tasks.length, isFinished: false }
}
