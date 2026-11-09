import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { AgentRun, Backlog, ChildSession, Config, Item, Ledger, Live, LiveEntry, Panel, QueueFilter, Sibling, Signal, View } from '../types'
import { addItem, emptyBacklog, moveItem, readiness, removeItem, renderBacklogMd, updateItem } from './backlog'
import type { Readiness } from './backlog'
import { cleanList, planOf } from './clean'
import { DEFAULTS, draftConfig, normalizeConfig } from './config'
import { hashRoot, livePath, parseJson, paths, serialize } from './files'
import { ledgerText, mergeLedger, emptyLedger } from './ledger'
import type { LedgerSet } from './ledger'
import { parseLive, siblingsOf, withEntry, withoutEntry } from './live'
import { activeFromBranches, bulkToRemove, decisionsFromBacklogMd, findSources, historicalLine, incrementsOf, itemsFromBacklogMd, itemsFromMvpQueue, renderRulesMd, repoWebUrl, rulesFromProse, specStub } from './migrate'
import type { ActiveItem, Increment, MigrateRule } from './migrate'
import { BAND_COMPACT_H, BAND_H, bandSvg, bandText } from './draw'
import { BLOCKED, renderPanel } from './pane'
import { SEGMENT_COLORS, bandOf, specWhat, statusText, taskCounter } from './status'
import type { Band } from './status'
import type { StatusInput } from './status'
import { ALLOWED_MODES, appendOutput, branchOf as itemBranchOf, childArgv, childPrompt, childSignals, exitNote, runningOf, tail, withExit, withStopped, worktreeOf } from './runner'
import { STALE_MS, deadAgents, isProtected, mergeSignals, onCall, onComplete, onResult, onSpawn, onStep, onTouch, pathOf, signals as raiseSignals } from './watch'
import type { Call } from './watch'

const TOOL = 'mcp__pipeline__pipeline'
const PANE = 'pipeline'
const DESCRIPTION = 'The pipeline: `status`, `panel`, `config`, `init`, `add`, `next`, `run`, `migrate`, `stop`, `log`, `move`, `park`, `unpark`, `clean`'
const USAGE =
  'pipeline: status [id] | panel | config [key=value] | init | add <text> | next | run <id> | run all | migrate | stop [id] | log <id> | move <id> top | move <id> after <id> | park <id> | unpark <id> | clean'
const CONFIG_KEYS = ['mainBranch', 'branch', 'checks', 'riskyPaths', 'protectedPaths', 'models', 'limits', 'runner', 'merge', 'mergeMethod', 'stop', 'afterMerge', 'retain', 'notify']
const CONFIG_FILE = 'docs/pipeline/config.json'
const BACKLOG_FILE = 'docs/pipeline/backlog.json'
const BACKLOG_MD_FILE = 'docs/pipeline/BACKLOG.md'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TICK_MS = 30_000
const HEARTBEAT_MS = 2000
const WAKE_PROMPT = 'pipeline: check the watchdog signals with the pipeline tool'
/** The log file of a child, under the main checkout's .git (shared by every worktree, never committed). */
const childLog = (found: string, id: string) => `${found}/.git/pipeline/${id}.log`
const LOG_WRITE_MS = 1000
const ACTIVE_STATUSES = ['planning', 'building', 'review'] as const
const STATUSES: readonly string[] = ['inbox', 'ready', 'planning', 'building', 'review', 'merged', 'blocked', 'parked']

const TOOL_DESCRIPTION =
  'The pipeline: backlog and status. Main session only; a subagent\'s call is ignored. Actions: ' +
  '`get` → JSON { config, backlog, readiness, active, resume, signals, children, siblings }: the active item, its ledger\'s resume block, the open watchdog signals (silent, dead, looping, budget), each delivered once, the child sessions this session runs (id, item, status, lastLine, no log) and the other sessions on the repository; ' +
  '`status` { id? } → the status block, or one item\'s ledger as text; ' +
  '`add` { item: { title, size, needs, source, note } } → appends an inbox item with the next id and answers `added <id>` and the status; ' +
  '`update` { id, set: { ...fields } } → merges fields into the item (status, spec, plan, branch, pr, note, needs, size, title); ' +
  '`move` { id, to: "top" | { after: "<id>" } } → reorders; ' +
  '`remove` { id }; `park` { id }; `unpark` { id }; ' +
  '`ledger` { item: "<id>", set: { tasks?: [{ n, title?, status?, commits?, dispatches?: [{ role, model, effort, tokens, minutes, result, risky? }], review? }], rulings?: [{ task?, text, why, costIfWrong }], resume?: { task, state, lastVerified? }, final?: { verdict, gate?, tokens?, findings? }, blockers?: [..], pr?, branch?, worktree?, base?, plan? } } ' +
  '→ merges into docs/pipeline/ledgers/<id>.json (tasks by n with dispatches appended, rulings appended and numbered, blockers appended, tokens recomputed), creates it and links it from the item when missing, mirrors branch, pr and plan onto the item, and answers the ledger as text; ' +
  '`init` → writes config.json with the defaults, an empty backlog.json and BACKLOG.md when no config exists; ' +
  '`start` { item: "<id>" } (runner session only) → makes the item\'s worktree (.claude/worktrees/<id>, branch from config.branch off mainBranch, reused when there), marks the item building with the note `session runner`, records branch and worktree in its ledger and starts a headless Claude Code child in the worktree in this session\'s permission mode (acceptEdits, auto, dontAsk or bypassPermissions; otherwise refused with what to switch to; refused too past limits.parallel, for an item that is not ready, blocked or building with the note `session runner` and no child, for a building item run in-session, while a child runs it, and from a child session, which starts no children), answering one line with the session id and the log path; the child runs the item with the run skill and leaves the item as it ends it, a non-zero exit blocks it with the code and the log tail; ' +
  '`stop` { item } → kills the item\'s child session and sets the item blocked with `stopped by the user` unless it had merged; ' +
  '`log` { item } → the last 60 lines of the child\'s log; ' +
  '`clean` { item? } → the repo-relative paths config.retain says may go, one per line (a merged item\'s ledgers/<id>/ unless retain.briefs, its plan unless retain.plans, its .superpowers/sdd/ folders unless retain.superpowers, its worktree under .claude/worktrees/), for one merged item or for every merged item; it deletes nothing, the caller removes them with git rm -r and commits; ' +
  '`migrate` { refresh? } → JSON { sources, config, sourcesOfConfig, items, rules, active, bulk: { files, count }, unsure, report }: reads the project\'s queue, workflow prose, ledgers, scripts and CI and drafts the config, the items, the rules (the queue\'s open decisions among them, as before-dispatch stops) and the active item, writing nothing; refused when config.json exists unless refresh; ' +
  '`migrate-apply` { config, items, rules, refresh? } → writes config.json, rules.md, backlog.json and BACKLOG.md from the corrected drafts (items in order with new ids, needs mapped from the queue labels, a building item\'s resume into its ledger, a spec stub from the title and note for every inbox or building item without one, so the needs-free ones settle to ready), prepends the Historical line once to the old queue and ledger files, and answers the status, the count of spec stubs, the count of files given the line and the bulk files to git rm; refused when docs/pipeline/ exists unless refresh, and a refresh changes no status. ' +
  'Every write re-reads backlog.json, merges, regenerates BACKLOG.md and answers the status text; a file that does not parse is refused with its line and left alone.'

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['get', 'status', 'add', 'update', 'move', 'remove', 'park', 'unpark', 'ledger', 'init', 'clean', 'migrate', 'migrate-apply', 'start', 'stop', 'log'] },
    id: { type: 'string', description: 'The item id, as p12.' },
    item: {
      type: ['object', 'string'],
      description: 'For add: the new item; it starts as inbox. For ledger, start, stop and log: the item id, as p12.',
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
    refresh: { type: 'boolean', description: 'For migrate and migrate-apply: go on although docs/pipeline/ exists; the apply then refreshes titles, sources and links and changes no status.' },
    config: { type: 'object', description: 'For migrate-apply: the corrected config, as migrate drafted it.' },
    items: { type: 'array', description: 'For migrate-apply: the corrected items in queue order (title, status, size, needs, source, spec, plan, pr, note; a building item with branch and resume), as migrate drafted them; needs may name the queue labels.', items: { type: 'object' } },
    rules: { type: 'array', description: 'For migrate-apply: the corrected rules, each { group, line, source }.', items: { type: 'object' } },
  },
  required: ['action'],
}

const root = atom({ plugin: 'pipeline', key: 'root' } as const, '')
const config = atom({ plugin: 'pipeline', key: 'config' } as const, null as Config | null)
const backlog = atom({ plugin: 'pipeline', key: 'backlog' } as const, null as Backlog | null)
const fileError = atom({ plugin: 'pipeline', key: 'fileError' } as const, null as string | null)
const agents = atom({ plugin: 'pipeline', key: 'agents' } as const, [] as AgentRun[])
const signals = atom({ plugin: 'pipeline', key: 'signals' } as const, [] as Signal[])
// The session runner's children and the other sessions on this repository, as the panel draws them; the runner keeps them.
const children = atom({ plugin: 'pipeline', key: 'children' } as const, [] as ChildSession[])
const siblings = atom({ plugin: 'pipeline', key: 'siblings' } as const, [] as Sibling[])
const panel = atom({ plugin: 'pipeline', key: 'panel' } as const, { view: 'overview', filter: 'inbox', search: '', expanded: null, isMoreShown: false, autoOpenedFor: '', isBandOpen: false } as Panel)
// The clock the panel draws against: the ticker moves it, so minutes and the merged week stay current.
const now = atom({ plugin: 'pipeline', key: 'now' } as const, 0)

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// ---------- the panel ----------

/** The `autoOpen` and `band` settings as this load of the module received them. */
let isAutoOpen = true
let isCompactBand = false

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

/** With runner session the lead only starts children: the mod's `start` does the worktree and the child does the rest. */
const SESSION_RUN_PROMPT = (target: string) => {
  const what =
    target === 'all'
      ? 'each ready item in order up to limits.parallel children, and again for the next ready item each time a child finishes (the wake-up or the next get brings you back; a child that exited non-zero left its item blocked with the reason)'
      : target
        ? `item ${target}`
        : 'the first ready item'
  return `Use the pipeline-run skill with runner session. First tool call: ${call({ action: 'get' })}. Then call ${call({ action: 'start', item: '<id>' })} for ${what}; the child session does the planning, the build, the review and the PR in its worktree. Answer the tool's one line and stop; never run the item in this session.`
}

const MIGRATE_PROMPT = `Use the pipeline-migrate skill. First tool call: ${call({ action: 'migrate' })}, which reads the project's queue, workflow prose and ledgers and drafts the config, the rules and the items without writing. Then finish the mapping, ask once, and apply as the skill says.`

const INIT_PROMPT =
  `Set the pipeline up in this project with the pipeline-init skill: read it and follow its steps. If the project already has a queue, a workflow document or a ledger, it hands over to the pipeline-migrate skill, whose first tool call is ${call({ action: 'migrate' })}; otherwise its first tool call is ${call({ action: 'init' })}.`

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
  // The permission mode the engine last told us (a prompt's, a spawn's); a child runs in it.
  permissionMode: '',
  // The running child processes by item: the stream whose end kills the child, the unread tail of a line, the log throttle.
  procs: new Map<string, { stream: AsyncGenerator<{ stream: string; text: string }, { code: number | null; signal: string | null }> | null; partial: string; lastWrite: number }>(),
}

/** The web URL of the repository's origin, for PR numbers the old queue names; nothing without a remote. */
async function repoUrl($: EngineInterface): Promise<string | undefined> {
  try {
    return repoWebUrl((await $.session.repo())?.remote)
  } catch {
    return undefined
  }
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
  refresh?: boolean
  config?: unknown
  items?: unknown
  rules?: unknown
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

/**
 * The ledger of an item, when its file is on disk and parses, normalised through the merge so every consumer sees
 * the arrays (a hand-made file, or one from another tool, may leave `tasks`, `rulings` or `blockers` out).
 */
async function loadLedger($: EngineInterface, found: string, id: string): Promise<Ledger | null> {
  try {
    const parsed = (await readLedger($, found, id)).value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const set = parsed as unknown as LedgerSet
    const lists = { tasks: Array.isArray(set.tasks) ? set.tasks : [], rulings: Array.isArray(set.rulings) ? set.rulings : [], blockers: Array.isArray(set.blockers) ? set.blockers.filter((b): b is string => typeof b === 'string') : [] }
    return mergeLedger(emptyLedger(id), { ...set, ...lists }, await nowIso($))
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
    // The active item is the one in planning, building or review; resume is null until its ledger has the block.
    const active = activeItem(loaded)
    const ledger = active ? await loadLedger($, found, active.id) : null
    // A child's record without its log (up to 200 KB each): `log { item }` answers the text.
    const kids = (await read($, children)).map(({ log: _log, ...rest }) => rest)
    const out: Record<string, unknown> = { config: c, backlog: loaded, readiness: r, active: active?.id ?? null, resume: ledger?.resume ?? null, signals: open, children: kids, siblings: await read($, siblings) }
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
  if (e.action === 'migrate') {
    if (!e.refresh && (await $.fs.exists(p.config))) throw new Refused(`${CONFIG_FILE} exists; pass refresh: true to draft again`)
    return JSON.stringify(await migrateDraft($, found), null, 2)
  }
  if (e.action === 'migrate-apply') {
    if (!e.refresh && (await $.fs.exists(p.dir))) throw new Refused('docs/pipeline/ exists; pass refresh: true to refresh titles, sources and links without changing a status')
    if (error) throw new Refused(error)
    return migrateApply($, found, loaded, e)
  }

  if (e.action === 'log') {
    const id = typeof e.item === 'string' ? e.item : e.item?.id ?? e.id
    if (!id) throw new Refused('an id is needed')
    const child = (await read($, children)).find(ch => ch.item === id)
    const log = child?.log || (await readText($, childLog(found, id))) || ''
    return log ? tail(log) : `no log for ${id}`
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
      // A ledger file the item does not link is a leftover of a removed item: never merged into silently.
      const linked = current.items.find(i => i.id === id)?.ledger
      if (onDisk.value && (linked === null || linked === undefined)) {
        throw new Refused(`${ledgerFile(id)} exists but ${id} has no ledger link: a stale file of an earlier item; move or delete it, or link it with update { id: "${id}", set: { ledger: "${ledgerFile(id)}" } }`)
      }
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
    case 'start':
      return startChild($, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id))
    case 'stop':
      return stopChild($, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id))
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

// ---------- the session runner ----------

/** The variable a child session is started with; a session that sees it starts no children. */
const CHILD_MARK = 'PIPELINE_CHILD'

/** Whether this session was started by the session runner: the mark is in its environment. */
async function isChildSession($: EngineInterface): Promise<boolean> {
  try {
    return Boolean(await $.env.get('PIPELINE_CHILD'))
  } catch {
    return false
  }
}

/** The session's permission mode: the one the engine last told us, else the settings' default mode, else `default`. */
async function permissionModeOf($: EngineInterface): Promise<string> {
  if (self.permissionMode) return self.permissionMode
  try {
    const permissions = await $.settings.read({ key: 'permissions' })
    const mode = permissions && typeof permissions === 'object' ? (permissions as { defaultMode?: unknown }).defaultMode : undefined
    if (typeof mode === 'string' && mode) return mode
  } catch {}
  return 'default'
}

/** The item's worktree: made off mainBranch on its branch, reused when it is there, added on the branch alone when the branch exists. */
async function ensureWorktree($: EngineInterface, found: string, worktree: string, branch: string, mainBranch: string): Promise<void> {
  try {
    if (await $.fs.exists(worktree)) return
  } catch {}
  const add = async (argv: string[]) => {
    try {
      return await $.process.run(argv, { cwd: found, timeoutMs: 120_000 })
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  }
  let r = await add(['git', 'worktree', 'add', worktree, '-b', branch, mainBranch])
  if (r.exitCode !== 0 && /already exists/i.test(r.stderr)) r = await add(['git', 'worktree', 'add', worktree, branch])
  if (r.exitCode !== 0) throw new Refused(`git worktree add failed: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}`)
}

const list = (xs: readonly string[]) => `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`

/** `start`: the checks, the worktree, the item marked building, the ledger's branch and worktree, the child spawned and its loop detached. */
async function startChild($: EngineInterface, found: string, c: Config | null, current: Backlog, id: string): Promise<string> {
  // The mechanical guard against recursion: a child is started with PIPELINE_CHILD set, and never starts children.
  if (await isChildSession($)) throw new Refused('a child session does not start children')
  const runner = c?.runner ?? DEFAULTS.runner
  if (runner !== 'session') throw new Refused(`runner is ${runner}; set it with /pipeline config runner=session`)
  const item = current.items.find(i => i.id === id)!
  const running = runningOf(await read($, children))
  const own = running.find(ch => ch.item === id)
  if (own) throw new Refused(`${id} already runs in session ${own.id}`)
  if (item.status !== 'ready' && item.status !== 'blocked' && item.status !== 'building') throw new Refused(`${id} is ${item.status}, not ready`)
  // A building item the session runner did not start is being run in a session, this one or another: not taken over.
  if (item.status === 'building' && !/session runner/.test(item.note ?? '')) throw new Refused(`${id} is being run in-session (building, note: ${item.note || 'none'}); finish or stop that run, or block the item, before starting it as a child session`)
  const mode = await permissionModeOf($)
  if (!(ALLOWED_MODES as readonly string[]).includes(mode)) {
    throw new Refused(`the session's permission mode is ${mode}; a headless child cannot ask, so switch to ${list(ALLOWED_MODES)} (Shift+Tab) and start again`)
  }
  const parallel = limitsOf(c).parallel
  if (running.length >= parallel) throw new Refused(`${running.length} child session${running.length === 1 ? '' : 's'} running; limits.parallel is ${parallel}`)
  const worktree = worktreeOf(found, id)
  const branch = itemBranchOf(c?.branch ?? DEFAULTS.branch, id)
  await ensureWorktree($, found, worktree, branch, c?.mainBranch ?? DEFAULTS.mainBranch)
  const at = await $.clock.now()
  const sessionId = crypto.randomUUID()
  const isResume = item.status !== 'ready'
  const note = item.status === 'blocked' && item.note ? `session runner · was blocked: ${item.note}` : 'session runner'
  await writeBacklog($, found, c, updateItem(current, id, { status: 'building', note }, new Date(at).toISOString()))
  try {
    await runTool($, { action: 'ledger', item: id, set: { branch, worktree: `.claude/worktrees/${id}` } })
  } catch {}
  const child: ChildSession = { id: sessionId, item: id, worktree, branch, status: 'starting', startedAt: at, log: '' }
  await update($, children, prev => [...prev.filter(ch => ch.item !== id), child])
  const argv = childArgv({ prompt: childPrompt(id, { isResume }), permissionMode: mode, sessionId })
  // `env` is set over the host's environment, so the child inherits the rest and sees the mark.
  void runChild($, found, child, { argv, cwd: worktree, env: { [CHILD_MARK]: '1' } })
  await heartbeat($, true)
  return `started ${id} in .claude/worktrees/${id} · session ${sessionId} · log .git/pipeline/${id}.log`
}

/** The child's life: its output into the record and the log file, piece by piece, then its end. */
async function runChild($: EngineInterface, found: string, child: ChildSession, request: { argv: string[]; cwd: string; env: Record<string, string> }): Promise<void> {
  const logPath = childLog(found, child.item)
  const proc = { stream: null as null | AsyncGenerator<{ stream: string; text: string }, { code: number | null; signal: string | null }>, partial: '', lastWrite: -Infinity }
  self.procs.set(child.item, proc)
  let end: { code: number | null; signal: string | null } = { code: null, signal: 'SIGTERM' }
  try {
    const stream = $.process.spawn(request)
    proc.stream = stream
    for (;;) {
      const r = await stream.next()
      if (r.done) {
        if (r.value) end = r.value
        break
      }
      const at = await $.clock.now()
      const before = (await read($, children)).find(ch => ch.id === child.id)
      if (!before) break
      const { child: next, partial } = appendOutput(before, r.value.text, proc.partial)
      proc.partial = partial
      const after = { ...next, status: next.status === 'starting' ? ('running' as const) : next.status }
      await update($, children, prev => prev.map(ch => (ch.id === child.id ? after : ch)))
      if (at - proc.lastWrite >= LOG_WRITE_MS) {
        proc.lastWrite = at
        try {
          await $.fs.write(logPath, after.log)
        } catch {}
      }
    }
  } catch (err) {
    // The child could not start, or the stream failed: the record says so and the item is blocked below.
    end = { code: 1, signal: null }
    const message = `could not run the child: ${err instanceof Error ? err.message : String(err)}`
    await update($, children, prev => prev.map(ch => (ch.id === child.id ? { ...ch, log: `${ch.log}${message}\n`, lastLine: message } : ch))).catch(() => {})
  } finally {
    // Only this child's own entry: the item may have been started again while this process was still ending.
    if (self.procs.get(child.item) === proc) self.procs.delete(child.item)
  }
  try {
    await finishChild($, found, child.id, end, proc.partial, logPath)
  } catch {}
}

/** The child ended: the record closed, the log flushed, a failed exit blocks the item, the person hears of it. */
async function finishChild($: EngineInterface, found: string, id: string, end: { code: number | null; signal: string | null }, partial: string, logPath: string): Promise<void> {
  const at = await $.clock.now()
  const before = (await read($, children)).find(ch => ch.id === id)
  if (!before) return
  const flushed = partial.trim() ? appendOutput(before, '\n', partial).child : before
  const after = withExit(flushed, end, at)
  await update($, children, prev => prev.map(ch => (ch.id === id ? after : ch)))
  try {
    await $.fs.write(logPath, after.log)
  } catch {}
  const c = await read($, config)
  // Stopped by the person: the item was blocked then. Failed: blocked now, unless the child got it past the build.
  if (before.status !== 'stopped' && after.status === 'failed') {
    const { backlog: fresh, error } = await loadAll($, found)
    const item = fresh?.items.find(i => i.id === after.item)
    if (!error && fresh && item && item.status !== 'merged' && item.status !== 'review') {
      await writeBacklog($, found, c, updateItem(fresh, item.id, { status: 'blocked', note: exitNote(after, end) }, new Date(at).toISOString()))
      try {
        await runTool($, { action: 'ledger', item: item.id, set: { blockers: [exitNote(after, end)] } })
      } catch {}
    }
  }
  if (before.status !== 'stopped') await announce($, c, `pipeline: child ${after.item} ${after.status}${after.lastLine ? ` · ${after.lastLine}` : ''}`)
  await heartbeat($, true)
}

/** `stop`: the child's stream closed, which kills it; the record stopped; the item blocked unless it is past the build. */
async function stopChild($: EngineInterface, found: string, c: Config | null, current: Backlog, id: string): Promise<string> {
  const child = runningOf(await read($, children)).find(ch => ch.item === id)
  if (!child) throw new Refused(`no child session runs ${id}`)
  const at = await $.clock.now()
  await update($, children, prev => prev.map(ch => (ch.id === child.id ? withStopped(ch, at) : ch)))
  const proc = self.procs.get(id)
  // Not awaited: the engine kills the child when the loop is left, and the loop's own end closes the record.
  if (proc?.stream) void proc.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
  const item = current.items.find(i => i.id === id)
  const reason = 'stopped by the user'
  let outcome = ''
  if (item && item.status !== 'merged' && item.status !== 'review') {
    await writeBacklog($, found, c, updateItem(current, id, { status: 'blocked', note: reason }, new Date(at).toISOString()))
    try {
      await runTool($, { action: 'ledger', item: id, set: { blockers: [reason] } })
    } catch {}
    outcome = ` · ${id} blocked: ${reason}`
  } else if (item) outcome = ` · ${id} stays ${item.status}`
  await heartbeat($, true)
  return `stopped ${id} · session ${child.id}${outcome}`
}

// ---------- migration ----------

const SDD_DIR = '.superpowers/sdd'
const HISTORICAL = /^Historical\./

/** Repo-relative paths under `<root>/<dir>`, files and folders (with a slash), down to `depth` levels; nothing when the folder is not there. */
async function walk($: EngineInterface, found: string, dir: string, depth: number): Promise<string[]> {
  const out: string[] = []
  for (const name of await listDir($, dir ? `${found}/${dir}` : found)) {
    const rel = dir ? `${dir}/${name}` : name
    out.push(rel)
    if (name.endsWith('/') && depth > 1) out.push(...(await walk($, found, rel.slice(0, -1), depth - 1)))
  }
  return out
}

/** The project as the migration reads it: the listing of the known places, the branches and the superpowers increments. */
async function scanProject($: EngineInterface, found: string): Promise<{ listing: string[]; branches: string[]; increments: Increment[] }> {
  const listing: string[] = []
  const seen = new Set<string>()
  const add = (paths: string[]) => {
    for (const p of paths) if (!seen.has(p)) { seen.add(p); listing.push(p) }
  }
  const top = await walk($, found, '', 1)
  add(top)
  for (const dir of top.filter(p => p.endsWith('/') && !p.startsWith('.'))) if (await $.fs.exists(`${found}/${dir}CLAUDE.md`)) add([`${dir}CLAUDE.md`])
  add(await walk($, found, 'docs', 1))
  for (const dir of ['docs/superpowers/specs', 'docs/superpowers/plans', 'docs/superpowers/ledgers', '.github/workflows']) add(await walk($, found, dir, 1))
  add(await walk($, found, SDD_DIR, 5))
  add(await walk($, found, '.claude/skills', 2))

  const branches: string[] = []
  for (const p of await walk($, found, '.git/refs/heads', 6)) if (!p.endsWith('/')) branches.push(p.slice('.git/refs/heads/'.length))
  const packed = await readText($, `${found}/.git/packed-refs`)
  for (const m of (packed ?? '').matchAll(/^[0-9a-f]{40} refs\/heads\/(\S+)/gm)) if (!branches.includes(m[1]!)) branches.push(m[1]!)

  const increments: Increment[] = []
  for (const dir of listing.filter(p => p.startsWith(`${SDD_DIR}/`) && p.endsWith('/') && p.slice(SDD_DIR.length + 1, -1).indexOf('/') < 0)) {
    const name = dir.slice(SDD_DIR.length + 1, -1)
    const texts: string[] = []
    const pointer = await readText($, `${found}/${dir}plan-path`)
    if (pointer) texts.push(pointer.trim())
    const progress = await readText($, `${found}/${dir}progress.md`)
    const header = /^#\s+.*$/m.exec(progress ?? '')?.[0]
    if (header) texts.push(header)
    increments.push({ dir: name, pointer: texts.join('\n') })
  }
  return { listing, branches, increments }
}

const isMd = (p: string) => /\.md$/i.test(p)
const isLedger = (p: string) => /^\.superpowers\/sdd\/(?:.*\/)?progress\.md$/.test(p) || /^docs\/superpowers\/ledgers\/[^/]+\.md$/.test(p)
const isSkill = (p: string) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(p)
const isWorkflow = (p: string) => /^\.github\/workflows\/[^/]+$/.test(p)
const isClaudeMd = (p: string) => p === 'CLAUDE.md' || p.endsWith('/CLAUDE.md')

/** `migrate`: the sources read, the drafted config with its sources, the items, the rules, the active item, the bulk and the report. Writes nothing. */
async function migrateDraft($: EngineInterface, found: string): Promise<Record<string, unknown>> {
  const { listing, branches, increments } = await scanProject($, found)
  const claudeMd = (await readText($, `${found}/CLAUDE.md`)) ?? ''
  const sources = findSources(listing, claudeMd).filter(p => !p.endsWith('/'))
  const texts = new Map<string, string>()
  for (const file of sources) {
    const t = await readText($, `${found}/${file}`)
    if (t !== null) texts.set(file, t)
  }
  const report: string[] = []
  const yielded = (file: string, what: string) => report.push(`${file}: ${what}`)

  // The config from the scripts, the make targets, the CI and the prose.
  let scripts: Record<string, string> = {}
  const pkg = texts.get('package.json')
  if (pkg !== undefined) {
    const parsed = parseJson<{ scripts?: Record<string, unknown> }>(pkg, 'package.json')
    if (parsed.ok) {
      scripts = Object.fromEntries(Object.entries(parsed.value?.scripts ?? {}).filter((kv): kv is [string, string] => typeof kv[1] === 'string'))
      yielded('package.json', `${Object.keys(scripts).length} scripts`)
    } else yielded('package.json', `not read: ${parsed.error}`)
  }
  const makeTargets = [...(texts.get('Makefile') ?? '').matchAll(/^([a-zA-Z_-]+):/gm)].map(m => m[1]!)
  if (texts.has('Makefile')) yielded('Makefile', `${makeTargets.length} targets`)
  const ci = sources.filter(isWorkflow).map(f => texts.get(f) ?? '').join('\n')
  for (const f of sources.filter(isWorkflow)) yielded(f, 'CI workflow')
  const prose = sources.filter(f => isMd(f) && texts.has(f)).map(f => texts.get(f)!)
  const dirs = listing.filter(p => /^[^/]+\/$/.test(p)).map(p => p.slice(0, -1))
  const { config: drafted, sources: sourcesOfConfig } = draftConfig({ scripts, makeTargets, ci, dirs, prose })

  // The items: the markdown queue, the MVP queue of each CLAUDE.md.
  const items: Partial<Item>[] = []
  const decisions: MigrateRule[] = []
  const backlogMd = texts.get('docs/backlog.md')
  if (backlogMd !== undefined) {
    const own = itemsFromBacklogMd(backlogMd, 'docs/backlog.md', await repoUrl($))
    items.push(...own)
    decisions.push(...decisionsFromBacklogMd(backlogMd, 'docs/backlog.md'))
    const counts = `${own.length} items (${own.filter(i => i.status === 'merged').length} merged, ${own.filter(i => i.status === 'parked').length} parked)`
    yielded('docs/backlog.md', decisions.length ? `${counts}, ${decisions.length} open decision${decisions.length === 1 ? '' : 's'}` : counts)
  }
  for (const f of sources.filter(isClaudeMd)) {
    const own = itemsFromMvpQueue(texts.get(f) ?? '', f)
    items.push(...own)
    yielded(f, own.length ? `${own.length} queue entries` : 'no queue')
  }

  // The rules from the workflow prose.
  const ruleFiles = sources.filter(f => (isClaudeMd(f) || f === 'docs/WORKFLOW.md' || isSkill(f)) && texts.has(f))
  // The open decisions of the queue are stop rules before dispatch, not items.
  const rules = [...decisions, ...rulesFromProse(ruleFiles.map(file => ({ file, text: texts.get(file)! })))]
  for (const f of ruleFiles) {
    const n = rules.filter(r => r.source === f).length
    if (n || !isClaudeMd(f)) yielded(f, `${n} candidate rules`)
  }

  // The active item from the branches and the ledgers.
  const ledgerFiles = sources.filter(f => isLedger(f) && texts.has(f))
  const active = activeFromBranches(branches, ledgerFiles.map(file => ({ file, text: texts.get(file)! })))
  for (const f of ledgerFiles) {
    const hit = active.find(a => a.ledger === f)
    yielded(f, hit ? `ledger of ${hit.branch}, resume at task ${hit.resume.task}` : 'ledger, no open feat branch')
  }
  for (const f of sources) if (!report.some(r => r.startsWith(`${f}: `))) yielded(f, texts.has(f) ? 'read, nothing taken' : 'not readable')

  // The bulk of the merged increments.
  const { merged, unsure } = incrementsOf(increments, items)
  const bulk = bulkToRemove(listing, merged)
  if (merged.length) report.push(`merged increments: ${merged.join(', ')} (${bulk.count} files to remove)`)
  if (unsure.length) report.push(`unsure increments (a folder named like a merged item, no plan match): ${unsure.join(', ')}`)
  report.push(`branches: ${branches.length ? branches.join(', ') : 'none found under .git/refs/heads'}`)

  return { sources, config: drafted, sourcesOfConfig, items, rules, active, bulk, unsure, report: report.join('\n') }
}

type ApplyItem = Partial<Item> & { resume?: ActiveItem['resume'] }

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** `migrate-apply`: the four files from the corrected drafts, the ledger of a building item, the Historical lines, the bulk list. */
async function migrateApply($: EngineInterface, found: string, loaded: Backlog | null, e: ToolInput): Promise<string> {
  const p = paths(found)
  const now = await nowIso($)
  const isRefresh = Boolean(e.refresh)

  const { config: given, problems } = normalizeConfig(e.config ?? {})
  if (problems.length) throw new Refused(problems.join('; '))
  if (!Array.isArray(e.items)) throw new Refused('migrate-apply needs items')
  const items = e.items.filter(isRecord) as ApplyItem[]
  for (const it of items) {
    if (typeof it.title !== 'string' || !it.title.trim()) throw new Refused('every item needs a title')
    if (it.status !== undefined && !STATUSES.includes(it.status)) throw new Refused(`item "${it.title.trim()}": unknown status ${JSON.stringify(it.status)}`)
  }
  const rules = (Array.isArray(e.rules) ? e.rules : []).filter((r): r is MigrateRule => isRecord(r) && typeof r['line'] === 'string' && typeof r['group'] === 'string')

  // The config: on a refresh the file on disk is the user's and stays as it is (the re-draft would overwrite
  // keys they tuned); it is written only when missing.
  const onDisk = isRefresh ? await loadJson<Record<string, unknown>>($, p.config, CONFIG_FILE) : { value: null, error: null }
  if (onDisk.error) throw new Refused(onDisk.error)
  const nextConfig = onDisk.value ?? given
  if (!onDisk.value) await $.fs.write(p.config, serialize(given))
  await update($, config, () => normalizeConfig(nextConfig).config)
  if (!isRefresh || !(await $.fs.exists(p.rules))) await $.fs.write(p.rules, renderRulesMd(rules))

  // The items: added in order with new ids; on a refresh matched by id or title and only their titles, sources and links
  // refreshed (the ledger link is the tool's own and stays).
  let next: Backlog = loaded ?? emptyBacklog()
  const ids = new Map<string, string>()
  const fresh = new Set<string>()
  const LINKS = ['title', 'source', 'spec', 'plan', 'pr'] as const
  const ledgers: { id: string; item: ApplyItem }[] = []
  for (const it of items) {
    const { id: label, needs: _n, resume: _r, status, ...rest } = it
    const title = it.title!.trim()
    const existing = isRefresh ? next.items.find(i => (label !== undefined && i.id === label) || i.title === title) : undefined
    if (existing) {
      const fields: Partial<Item> = {}
      for (const k of LINKS) if (it[k] !== undefined && it[k] !== existing[k]) fields[k] = it[k] as never
      if (Object.keys(fields).length) next = updateItem(next, existing.id, fields, now)
      if (label) ids.set(label, existing.id)
      continue
    }
    const fields: Partial<Item> & { title: string } = { ...rest, title, status: status ?? 'inbox' }
    next = addItem(next, fields, now)
    const id = next.items[next.items.length - 1]!.id
    fresh.add(id)
    if (label) ids.set(label, id)
    if (status === 'building' && it.resume) ledgers.push({ id, item: it })
  }
  // The needs of the items added now, once every id is known: a queue label becomes the id it got, an unknown one goes into the note.
  const known = new Set(next.items.map(i => i.id))
  for (const it of items) {
    const target = (it.id !== undefined ? ids.get(it.id) : undefined) ?? next.items.find(i => i.title === it.title?.trim())?.id
    if (!target || !fresh.has(target) || !Array.isArray(it.needs) || !it.needs.length) continue
    const needs: string[] = []
    const unknown: string[] = []
    for (const n of it.needs) {
      const mapped = ids.get(String(n)) ?? (known.has(String(n)) ? String(n) : undefined)
      if (mapped && mapped !== target) needs.push(mapped)
      else if (!mapped) unknown.push(String(n))
    }
    const item = next.items.find(i => i.id === target)!
    const fields: Partial<Item> = { needs }
    if (unknown.length) fields.note = [item.note, `needs ${unknown.join(', ')}, not in the import`].filter(Boolean).join('; ')
    next = updateItem(next, target, fields, now)
  }
  for (const { id, item } of ledgers) {
    const file = ledgerFile(id)
    const ledger: Ledger = {
      ...emptyLedger(id),
      ...(typeof item.branch === 'string' ? { branch: item.branch } : {}),
      ...(typeof item.plan === 'string' ? { plan: item.plan } : {}),
      ...(typeof item.ledger === 'string' ? { importedFrom: item.ledger } : {}),
      resume: { ...item.resume!, at: now },
    }
    await $.fs.write(p.ledger(id), serialize(ledger))
    next = updateItem(next, id, { ledger: file }, now)
  }
  // A spec stub for every item added now that lands inbox or building without one, so settle can make the
  // needs-free ones ready; an existing file at the stub's path is left alone.
  let stubs = 0
  for (const item of next.items) {
    if (!fresh.has(item.id) || (item.status !== 'inbox' && item.status !== 'building') || item.spec) continue
    const file = `docs/pipeline/specs/${item.id}.md`
    if (!(await $.fs.exists(p.spec(item.id)))) {
      await $.fs.write(p.spec(item.id), specStub(item.id, item.title, item.note, item.source))
      stubs += 1
    }
    next = updateItem(next, item.id, { spec: file }, now)
  }
  const status = await writeBacklog($, found, normalizeConfig(nextConfig).config, next)

  // The Historical line, once, on the old queue and ledger files.
  const { listing, increments } = await scanProject($, found)
  // The old queue, the top-level ledger and its archive, and every nested progress.md and final review.
  const old = ['docs/backlog.md', 'docs/SLICES.md', ...listing.filter(f => /^\.superpowers\/sdd\/(?:.*\/)?(?:progress\.md|progress-archive\.md|final-review[^/]*\.md)$/.test(f))]
  let added = 0
  for (const f of old) {
    const text = await readText($, `${found}/${f}`)
    if (text === null || HISTORICAL.test(text)) continue
    await $.fs.write(`${found}/${f}`, `${historicalLine(now.slice(0, 10))}\n\n${text}`)
    added += 1
  }
  const bulk = bulkToRemove(listing, incrementsOf(increments, next.items).merged)
  const lines = [status, `spec stubs written for ${stubs} item${stubs === 1 ? '' : 's'}`, `historical line added to ${added} file${added === 1 ? '' : 's'}`]
  if (bulk.count) lines.push(`bulk: ${bulk.count} files of merged increments to remove with git rm once the user confirms (kept with retain.superpowers):`, ...bulk.files)
  return lines.join('\n')
}

// ---------- the watchdog and the live file ----------

/** The limits in force: the config's over the defaults, so a partial config still has every number. */
function limitsOf(c: Config | null): Config['limits'] {
  const given = c && typeof c.limits === 'object' && c.limits ? c.limits : {}
  const out = { ...DEFAULTS.limits }
  for (const k of Object.keys(out) as (keyof Config['limits'])[]) {
    const v = (given as Partial<Config['limits']>)[k]
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
  const active = activeItem(await read($, backlog))
  // An item a child session runs, or ran, is the child's: its own entry names it, and a child that exited with the
  // item still building leaves it to the dead signal, not to this session's entry.
  const owned = new Set((await read($, children)).map(ch => ch.item))
  const item = active && !owned.has(active.id) ? active : null
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

/**
 * Writes this session's entry after a fresh read of the file, throttled to one write per 2 s unless forced.
 * Every file this module writes (the live file, the backlog, a ledger, the config) goes through a direct
 * `$.fs.write`: the API has no rename, so a write-to-temp-then-rename is not available; the reads parse
 * defensively instead, and a file that does not parse is refused and left alone.
 */
async function heartbeat($: EngineInterface, isForced = false): Promise<void> {
  try {
    const at = await $.clock.now()
    if (!isForced && at - self.lastWrite < HEARTBEAT_MS) return
    self.lastWrite = at
    const path = await liveFile($)
    const id = await $.session.id()
    const current = parseLive((await readText($, path)) ?? '')
    await $.fs.write(path, serialize(withEntry(current, id, await entryOf($, current.sessions[id], at), at)))
    await refreshSiblings($, current, id, at)
  } catch {}
}

/**
 * The other sessions of the live file into the atom: the children this session runs are left out, and so is an
 * entry in this session's own cwd or root, which is this session's under an earlier id (after a /clear or a resume
 * the process goes on under a new id without a session.start).
 */
async function refreshSiblings($: EngineInterface, current: Live, id: string, at: number): Promise<void> {
  const own = (await read($, children)).map(ch => ch.id)
  const cwds: string[] = []
  for (const get of [() => $.session.cwd(), () => $.session.root()]) {
    try {
      cwds.push(slashes(await get()))
    } catch {}
  }
  await update($, siblings, () => siblingsOf(current, id, at, own, cwds))
}

/** A signal to the person, per `config.notify`: a push notification, or a toast when the push is refused. */
async function notify($: EngineInterface, c: Config | null, list: Signal[]): Promise<void> {
  const mode = c?.notify ?? DEFAULTS.notify
  if (mode === 'off') return
  for (const s of list) await announce($, c, `pipeline: ${s.kind} · ${s.agent} · ${s.detail}`)
}

/** One message to the person: a push notification, or a toast when the push is refused; nothing with notify off. */
async function announce($: EngineInterface, c: Config | null, text: string): Promise<void> {
  if ((c?.notify ?? DEFAULTS.notify) === 'off') return
  const message = text.slice(0, 200)
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

/**
 * Every 30 s: the signals due now join the atom and reach the person; an entry of another session that went
 * stale since this session started (it died under STALE_MS before our start, say) gives its dead signals now,
 * and is dropped from the file so it is reported once; the live file is refreshed.
 */
async function tick($: EngineInterface): Promise<void> {
  try {
    const at = await $.clock.now()
    let c = await read($, config)
    const kids = await read($, children)
    // Other sessions (the children, a sibling) write the backlog too: with the session runner the files are re-read.
    if (kids.length || c?.runner === 'session') {
      const found = (await read($, root)) || (await resolveRoot($))
      c = (await loadAll($, found)).config
    }
    const fresh = raiseSignals(await read($, agents), limitsOf(c), at, await read($, signals))
    if (fresh.length) {
      await update($, signals, list => [...list, ...fresh])
      await notify($, c, fresh)
    }
    if (kids.length) {
      const path = await liveFile($)
      const live = parseLive((await readText($, path)) ?? '')
      const before = await read($, signals)
      const added = mergeSignals(before, childSignals({ children: kids, live, items: (await read($, backlog))?.items ?? [], now: at, staleMs: STALE_MS })).slice(before.length)
      if (added.length) {
        await update($, signals, list => mergeSignals(list, added))
        await notify($, c, added)
      }
    }
    await reportGone($, at, c)
    await update($, now, () => at)
    await heartbeat($, true)
  } catch {}
}

/** The gone entries of other sessions in the live file: their signals restored and their agents dead, then dropped. */
async function reportGone($: EngineInterface, at: number, c: Config | null): Promise<void> {
  const path = await liveFile($)
  const id = await $.session.id()
  const current = parseLive((await readText($, path)) ?? '')
  // This session's own entry is alive by definition: it is refreshed by the heartbeat right after.
  const dead = deadAgents(withoutEntry(current, id), id, at)
  if (!dead.sessions.length) return
  let pruned = current
  for (const gone of dead.sessions) pruned = withoutEntry(pruned, gone)
  await $.fs.write(path, serialize(pruned))
  const before = await read($, signals)
  const added = mergeSignals(before, dead.signals).slice(before.length)
  if (!added.length) return
  await update($, signals, list => mergeSignals(list, added))
  await notify($, c, added.filter(s => dead.fresh.includes(s)))
}

/**
 * At session start: the undelivered signals of the entries that are gone (this session's id, a restart, or a
 * stale one) come back into the atom, and the agents they list running are dead; then this session's fresh
 * entry, and the ticker.
 */
async function arrive($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  const path = await liveFile($)
  const id = await $.session.id()
  let current = parseLive((await readText($, path)) ?? '')
  const dead = deadAgents(current, id, at)
  // Nothing that ran before this start is still running.
  await update($, agents, list => list.map(a => (a.status === 'running' ? { ...a, status: 'failed', endedAt: at } : a)))
  if (dead.sessions.length) {
    // A signal the atom still holds (the state survived) is not doubled; the restored ones stay undelivered.
    const before = await read($, signals)
    const added = mergeSignals(before, dead.signals).slice(before.length)
    if (added.length) await update($, signals, list => mergeSignals(list, added))
    for (const gone of dead.sessions) current = withoutEntry(current, gone)
    // The person hears of the dead ones now; a restored signal was announced when it was raised.
    const announced = added.filter(s => dead.fresh.includes(s))
    if (announced.length) await notify($, await read($, config), announced)
  }
  try {
    await orphanChildren($, at)
  } catch {}
  self.startedAt = new Date(at).toISOString()
  self.lastWrite = at
  await $.fs.write(path, serialize(withEntry(current, id, await entryOf($, undefined, at), at)))
  await refreshSiblings($, current, id, at)
  self.ticker?.cancel()
  self.ticker = $.clock.every(TICK_MS, () => void tick($))
}

const RESTARTED = 'the parent session restarted'

/**
 * The child records of a life before this one (the state survives a hot reload, the processes do not: a child dies
 * with its parent's module): every starting or running record whose item has no process here is failed, its item
 * blocked unless the child got it past the build, and a dead signal is raised once for each.
 */
async function orphanChildren($: EngineInterface, at: number): Promise<void> {
  const orphans = runningOf(await read($, children)).filter(ch => !self.procs.has(ch.item))
  if (!orphans.length) return
  const ids = new Set(orphans.map(o => o.id))
  await update($, children, prev => prev.map(ch => (ids.has(ch.id) ? { ...ch, status: 'failed' as const, endedAt: at, lastLine: RESTARTED } : ch)))
  const found = (await read($, root)) || (await resolveRoot($))
  const { config: c, backlog: fresh, error } = await loadAll($, found)
  const blocked: string[] = []
  if (!error && fresh) {
    let next = fresh
    for (const o of orphans) {
      const item = next.items.find(i => i.id === o.item)
      if (!item || item.status === 'merged' || item.status === 'review') continue
      next = updateItem(next, item.id, { status: 'blocked', note: RESTARTED }, new Date(at).toISOString())
      blocked.push(item.id)
    }
    if (blocked.length) await writeBacklog($, found, c, next)
    for (const id of blocked) {
      try {
        await runTool($, { action: 'ledger', item: id, set: { blockers: [RESTARTED] } })
      } catch {}
    }
  }
  const dead: Signal[] = orphans.map(o => ({ kind: 'dead', agent: `child ${o.item}`, agentId: o.id, detail: `${RESTARTED} while the child session ran${blocked.includes(o.item) ? ` · ${o.item} blocked` : ''} · resume with /pipeline run ${o.item}`, at, delivered: false }))
  const before = await read($, signals)
  const added = mergeSignals(before, dead).slice(before.length)
  if (!added.length) return
  await update($, signals, list => mergeSignals(list, added))
  await notify($, c, added)
}

/** Between items: one wake-up at `silentMinutes` while an agent runs, where the host offers ScheduleWakeup; never two pending. */
async function scheduleWake($: EngineInterface, at: number): Promise<void> {
  if (at < self.wakeUntil) return
  if (!(await read($, agents)).some(a => a.status === 'running') && !runningOf(await read($, children)).length) return
  let isOffered = false
  try {
    isOffered = (await $.tool.list()).some(t => t.name === 'ScheduleWakeup')
  } catch {}
  if (!isOffered) return
  const delaySeconds = limitsOf(await read($, config)).silentMinutes * 60
  self.wakeUntil = at + delaySeconds * 1000
  try {
    await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds, reason: 'pipeline: a subagent or a child session is running; the watchdog signals are checked at silentMinutes', prompt: WAKE_PROMPT, noop: true })
  } catch {}
}

export const register: Register = (on, options) => {
  isAutoOpen = (options as Record<string, unknown> | undefined)?.autoOpen !== 'never'
  isCompactBand = (options as Record<string, unknown> | undefined)?.band === 'compact'

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
      // The ending session's id is the event's: after a /clear or a resume `$.session.id()` may already answer
      // the id the process goes on under, and the entry under the old one would stay in the file for a day.
      const ending = typeof e.sessionId === 'string' && e.sessionId ? e.sessionId : await $.session.id()
      await $.fs.write(path, serialize(withoutEntry(current, ending)))
    } catch {}
    return next(e)
  })

  // The session's permission mode, as the engine tells it on each prompt and each spawn: a child runs in it.
  on('classic.UserPromptSubmit', async (_$, e, next) => {
    try {
      const mode = (e as { permission_mode?: unknown }).permission_mode
      if (typeof mode === 'string' && mode) self.permissionMode = mode
    } catch {}
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    try {
      if (typeof e.permissionMode === 'string' && e.permissionMode) self.permissionMode = e.permissionMode
    } catch {}
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
        // The session's root is read now, not at session.start: the lead may have entered a worktree since.
        let sessionRoot = self.sessionRoot
        try {
          sessionRoot = slashes(await $.session.root())
          self.sessionRoot = sessionRoot
        } catch {}
        if (path && isProtected(path, protectedOf(await read($, config)), [sessionRoot, await read($, root)])) {
          return { deny: `pipeline: ${path} is protected by ${CONFIG_FILE} protectedPaths` }
        }
      }
      const at = await $.clock.now()
      await update($, agents, list => onCall(list, agentId, call, at))
      void heartbeat($)
    } catch {}
    const result = await next(e)
    try {
      // The call came back: a sign of life, so one long shell command is not flagged silent.
      const at = await $.clock.now()
      await update($, agents, list => onTouch(list, agentId, at))
      if (e.tool === 'Bash') {
        const isError = Boolean(result && typeof result === 'object' && 'isError' in result && result.isError)
        await update($, agents, list => onResult(list, agentId, call, isError))
      }
    } catch {}
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
    let band: Band | null = null
    try {
      if (!e.props.hasSurvey) band = await bandNow($, e.props.isWorking)
    } catch {}
    if (!band) return next(e)
    // The engine's own placeholder ({ type: 'engine' }) is never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const other = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const cols = e.props.bodyColumns || 100
    let isOpen = false
    try {
      isOpen = (await read($, panel)).isBandOpen
    } catch {}
    const toggle = () => void update($, panel, prev => ({ ...prev, isBandOpen: !prev.isBandOpen }))
    const chevron = <Button key="band-expand" plain dimColor label={isOpen ? '⌃' : '⌄'} onPress={toggle} />
    const details = isOpen ? (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>{`Execution tasks · ${band.summary}`}</Text>
        {band.tasks.map((t, i) => (
          <Text key={`band-task-${i}`} color={t.segment === 'accepted' ? SEGMENT_COLORS.accepted : t.segment === 'current' ? band!.color : t.segment === 'blocked' ? SEGMENT_COLORS.blocked : undefined} dimColor={t.segment === 'pending'}>
            {`${t.segment === 'accepted' ? '✓' : t.segment === 'current' ? '•' : t.segment === 'blocked' ? '✕' : '○'} ${t.title}`}
          </Text>
        ))}
        {!band.tasks.length ? <Text dimColor>No ledger yet.</Text> : null}
      </Box>
    ) : null
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const width = Math.max(180, Math.min(1600, cols * 8 - 40)) - 24
      const height = isCompactBand ? BAND_COMPACT_H : BAND_H
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="flex-start">
            <Svg source={bandSvg(band, width, isCompactBand)} alt={`${band.id} ${band.state}: ${band.title}, ${band.count}, ${band.activity}`} width={width} height={height} />
            {chevron}
          </Box>
          {details}
          {other}
        </Box>
      )
    }
    const row = bandText(band, Math.max(10, cols - 4))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={band.color} bold>
            {row.head}
          </Text>
          {row.segments ? (
            <Text>
              <Text dimColor>· </Text>
              {band.segments.map((seg, i) => (
                <Text key={`seg-${i}`} color={seg === 'pending' ? undefined : seg === 'current' ? band!.color : SEGMENT_COLORS[seg]} dimColor={seg === 'pending'}>
                  {row.segments.charAt(i)}
                </Text>
              ))}
              {!band.segments.length ? <Text dimColor>▱</Text> : null}
            </Text>
          ) : null}
          {row.tail ? <Text dimColor>{`· ${row.tail}`}</Text> : null}
          {chevron}
        </Box>
        {details}
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
  // The engine refuses a submit from inside the command's own hook (it would wait on
  // the turn the hook holds), so the submit goes out from a timer once this hook is done.
  const prompt = (text: string, instruction: string): CommandAnswer => {
    $.clock.after(50, async () => {
      try {
        await $.prompt.submit({ text: instruction })
      } catch (err) {
        $.ui.toast(`pipeline: could not start the step: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
    return { text }
  }
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
      return prompt('pipeline: running the first ready item…', (await isSessionRunner($)) ? SESSION_RUN_PROMPT('') : RUN_PROMPT(''))
    case 'run':
      if (!arg || (arg !== 'all' && !ID.test(arg))) return { text: 'pipeline: run needs an id or all, as /pipeline run p12' }
      return prompt(arg === 'all' ? 'pipeline: running until nothing is ready…' : `pipeline: running ${arg}…`, (await isSessionRunner($)) ? SESSION_RUN_PROMPT(arg) : RUN_PROMPT(arg))
    case 'stop':
      if (arg && ID.test(arg)) return { text: await runTool($, { action: 'stop', item: arg }) }
      return prompt('pipeline: stopping after the running task…', STOP_PROMPT)
    case 'log':
      if (!ID.test(arg)) return { text: 'pipeline: log needs an id, as /pipeline log p12' }
      return { text: await runTool($, { action: 'log', item: arg }) }
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

/** Whether the config on disk says `runner: session`, so the commands hand the model the start prompt. */
async function isSessionRunner($: EngineInterface): Promise<boolean> {
  try {
    const found = (await read($, root)) || (await resolveRoot($))
    return (await loadConfig($, found)).value?.runner === 'session'
  } catch {
    return false
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

/** The first line of the active item's spec, for the running hero; nothing without a spec file. */
async function specLine($: EngineInterface, found: string, item: Item | null): Promise<string> {
  if (!item || typeof item.spec !== 'string' || !item.spec) return ''
  const text = await readText($, `${found}/${item.spec.replace(/^\/+/, '')}`)
  return text ? specWhat(text) : ''
}

/** A tool action pressed from the panel: its one-line answer as a toast, so the person sees what happened. */
async function pressTool($: EngineInterface, input: ToolInput): Promise<void> {
  let text: string
  try {
    text = await runTool($, input)
  } catch (err) {
    text = `refused: ${err instanceof Error ? err.message : String(err)}`
  }
  try {
    await $.ui.toast(`pipeline: ${text.split('\n')[0] ?? ''}`)
  } catch {}
}

async function drawPane($: EngineInterface, ui: ReturnType<EngineInterface['ui']['resolve']>, e: { surface: string; props: { bodyColumns?: number } }): Promise<RenderElement> {
  const found = (await read($, root)) || (await resolveRoot($))
  const c = await read($, config)
  const b = await read($, backlog)
  const d = await gather($, found, c, b, await read($, fileError))
  const p = await read($, panel)
  const kids = await read($, children)
  const ledgers: Record<string, Ledger | null> = {}
  for (const k of kids) ledgers[k.item] = await loadLedger($, found, k.item)
  const set = (patch: Partial<Panel>) => void update($, panel, prev => ({ ...prev, ...patch }))
  return renderPanel(ui, {
    ...d,
    now: Math.max(d.now, await read($, now)),
    surface: e.surface,
    hasSvg: 'Svg' in ui,
    bodyColumns: e.props.bodyColumns ?? 40,
    project: found.split('/').pop() || 'project',
    branch: (await branchOf($)) ?? '',
    panel: p,
    children: kids,
    siblings: await read($, siblings),
    ledgers,
    activeLine: await specLine($, found, activeItem(b)),
    limitMs: limitsOf(c).taskMinutes * 60_000,
    onView: (view: View) => set({ view }),
    onFilter: (filter: QueueFilter) => set({ filter, expanded: null }),
    onSearch: (search: string) => set({ search, expanded: null }),
    onExpand: (expanded: string | null) => set({ expanded }),
    onMore: () => void update($, panel, prev => ({ ...prev, isMoreShown: !prev.isMoreShown })),
    onStop: (item: string) => void pressTool($, { action: 'stop', item }),
    onLog: (item: string) => void pressTool($, { action: 'log', item }),
  })
}

// The item the band keeps showing after it left the active statuses (blocked, or just merged), until the next turn starts.
const bandHold = { item: '', sawIdle: false }

/**
 * The band's data while an item is planning, building or in review, and for a blocked or just-merged item until the
 * model's next turn starts (`isWorking` false once, then true again); nothing when idle.
 */
async function bandNow($: EngineInterface, isWorking: boolean): Promise<Band | null> {
  const b = await read($, backlog)
  let item = activeItem(b)
  if (item) {
    bandHold.item = item.id
    bandHold.sawIdle = false
  } else if (bandHold.item) {
    const held = b?.items.find(i => i.id === bandHold.item)
    if (held && (held.status === 'blocked' || held.status === 'merged')) {
      if (!isWorking) bandHold.sawIdle = true
      else if (bandHold.sawIdle) bandHold.item = ''
      if (bandHold.item) item = held
    } else bandHold.item = ''
  }
  if (!item) return null
  const found = (await read($, root)) || (await resolveRoot($))
  const ledger = await loadLedger($, found, item.id)
  const at = Math.max(await read($, now), await $.clock.now())
  const agent = (await read($, agents)).find(a => a.status === 'running')
  return bandOf(item, ledger, agent, at)
}
