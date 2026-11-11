import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { AgentRun, Backlog, ChildSession, Config, Item, Ledger, Live, LiveEntry, Panel, QueueFilter, Sibling, Signal, View } from '../types'
import { addItem, emptyBacklog, moveItem, readiness, removeItem, renderBacklogMd, updateItem } from './backlog'
import type { Readiness } from './backlog'
import { compactSignal, itemState, ledgerLine, slimGet } from './answers'
import { cleanList, planOf } from './clean'
import { DEFAULTS, draftConfig, normalizeConfig } from './config'
import { hashRoot, livePath, parseJson, paths, places, serialize } from './files'
import type { Places } from './files'
import * as tracker from './tracker'
import { QUESTION_MARK } from './tracker'
import type { Issue, Run } from './tracker'
import { EMPTY_EXTRAS, applyOps, extrasOf, isTrusted, issueBodyOf, labelsOf, migrationOf, openQuestionOf, opsFor, parseSpecComment, quoted, renderSpecComment, specCommentOf, toBacklog } from './queue'
import type { Extras, Leftover, Op } from './queue'
import { ledgerText, mergeLedger, emptyLedger, repairResume, shapeSet } from './ledger'
import { briefPaths, checkPlan, parsePlan, renderBrief, riskyMatches } from './plan'
import { PLAN_FORMAT } from './templates'
import type { BriefKind } from './templates'
import type { LedgerSet } from './ledger'
import { parseLive, siblingsOf, withEntry, withoutEntry } from './live'
import { candidates as mergeCandidates, fetchArgv, findMerged, isFetchDue, mergedLine } from './merged'
import type { Git, MergedPending } from './merged'
import { activeFromBranches, bulkToRemove, decisionsFromBacklogMd, findSources, historicalLine, incrementsOf, itemsFromBacklogMd, itemsFromMvpQueue, renderRulesMd, repoWebUrl, rulesFromProse, specStub } from './migrate'
import type { ActiveItem, Increment, MigrateRule } from './migrate'
import { BAND_COMPACT_H, BAND_H, bandSvg, bandText, idleStripSvg, idleStripText } from './draw'
import { BLOCKED, renderPanel } from './pane'
import { SEGMENT_COLORS, bandOf, idLabel, idleLine, sessionName, specWhat, statusText, taskCounter } from './status'
import type { Band } from './status'
import type { StatusInput } from './status'
import { ALLOWED_MODES, appendOutput, branchOf as itemBranchOf, childArgv, childPrompt, childSignals, exitNote, runningOf, tail, withExit, withStopped, worktreeOf } from './runner'
import { STALE_MS, deadAgents, isProtected, mergeSignals, normalizeCommand, toolFileNote, toolFileOf, toolFileWrittenBy, onCall, onComplete, onResult, onSpawn, onStep, onTouch, pathOf, signals as raiseSignals } from './watch'
import type { Call } from './watch'

const TOOL = 'mcp__pipeline__pipeline'
const PANE = 'pipeline'
const DESCRIPTION = 'The pipeline: `status`, `panel`, `config`, `init`, `add`, `next`, `run`, `migrate`, `stop`, `log`, `move`, `park`, `unpark`, `clean`'
const USAGE =
  'pipeline: status [id] | panel | config [key=value] | init | add <text> | next | run <id> | run all | migrate | stop [id] | log <id> | move <id> top | move <id> after <id> | park <id> | unpark <id> | clean'
const CONFIG_KEYS = ['mainBranch', 'branch', 'checks', 'riskyPaths', 'protectedPaths', 'models', 'limits', 'runner', 'merge', 'mergeMethod', 'taskReview', 'stop', 'afterMerge', 'retain', 'notify', 'superpowers', 'pushMain', 'queue', 'queueLabel']
const CONFIG_FILE = 'docs/pipeline/config.json'
const BACKLOG_FILE = 'docs/pipeline/backlog.json'
const BACKLOG_MD_FILE = 'docs/pipeline/BACKLOG.md'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TICK_MS = 30_000
const HEARTBEAT_MS = 2000
/** The last line of init and migrate-apply: the tool's files are versioned, never gitignored, and the record is not on main until this commit. */
const commitLine = (mainBranch: string) => `commit docs/pipeline/ on ${mainBranch} now: git add docs/pipeline && git commit`

const WAKE_PROMPT = `pipeline: check the watchdog signals with the pipeline tool: ${TOOL} {"action":"signals"}`
/** The log file of a child, under the main checkout's .git (shared by every worktree, never committed). */
const childLog = (found: string, id: string) => `${found}/.git/pipeline/${id}.log`
const LOG_WRITE_MS = 1000
const ACTIVE_STATUSES = ['planning', 'building', 'review'] as const
const STATUSES: readonly string[] = ['inbox', 'ready', 'planning', 'building', 'review', 'merged', 'blocked', 'parked']

const TOOL_DESCRIPTION =
  'The pipeline of this project: backlog, ledgers and the build loop. Main session only; a subagent\'s call is ignored. Every write answers one line. The pipeline-run and pipeline-rules skills say when to call what. Actions: ' +
  '`get` { id?, titles?, full? } → JSON: the active item of this session, its resume block, open watchdog signals (each delivered once), children, siblings, counts, the next three items, the config keys a run reads, and `mergedPending` (items whose PR was merged by hand; close them first). `signals` → the open signals only. `status` { id? } → the status block, or one item\'s ledger as text. ' +
  'Backlog: `add` { item: { title, size?, needs?, source?, note? } }, `update` { id, set }, `move` { id, to: "top" | { after } }, `remove` { id }, `park` { id }, `unpark` { id }. ' +
  'Run, in order: `begin` { item } claims the item, makes its worktree and branch, records the base and answers the worktree to enter. `plan` { item, attribution? } checks docs/pipeline/plans/<id>.md, seeds the tasks, commits the plan (a missing or unsound plan answers the format or the problems). ' +
  '`brief` { item, kind: implementer | fix | review | final, task?, findings?, carried?, commits?, escalate?, close?: { tokens, minutes, result } } renders the brief, opens the dispatch (closing the one before with `close`) and answers the Agent call to make; a review the config does not ask for answers `no review`. ' +
  '`accept` { item, task, tokens?, minutes?, verdict?, carried?, fact? } closes the dispatch, accepts the task, commits the records, pushes and answers the next Agent call (the next task, or the final review); `plan` answers the first one. `gate` { item, verdict?, tokens? } runs checks.gate itself, records it with the final verdict and pushes when green; red answers the output\'s tail. ' +
  '`close` { item, pr?, force? } closes an item whose pull request is on mainBranch, from wherever this session is (also from inside the item\'s worktree): the main checkout on mainBranch and pulled, the item merged, what config.retain lets go removed, docs/pipeline committed on mainBranch and pushed unless config.pushMain is false, the worktree and local branch removed (a worktree this session is inside is left and removed by a later begin or close). ' +
  '`ledger` { item, set: { tasks?: [{ n, status?, close?, dispatches?, review? }], rulings?: [{ task?, text, why, costIfWrong }], resume?: { task, state, lastVerified? }, final?: { verdict, gate? }, blockers?: [text], pr?, branch?, worktree?, base?, <any other key>?: value | null } } merges anything else into the ledger: text for resume is taken as its state, a wrong shape is refused and nothing is written, and null removes one of the other keys. ' +
  'Session runner: `start` { item } runs the item in a headless child session, `stop` { item }, `log` { item }. Setup: `init`, `migrate` { refresh? }, `migrate-apply` { config, items, rules, refresh? }, `clean` { item? } lists what config.retain says may go and deletes nothing. ' +
  'A file that does not parse is refused with its line and left alone. ' +
  'With config.queue github the open issues with the queue label are the backlog and an issue number is the id (12): `add` opens an issue, `spec` { id, text } posts or replaces the issue\'s spec comment, `question` { id, text } asks on the issue and holds the item, `init` { queue: "github" } sets it up; `move` and `remove` are refused. `migrate-github` { apply? } drafts, and with apply makes, the move of a file backlog onto issues.'

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['get', 'signals', 'status', 'add', 'update', 'move', 'remove', 'park', 'unpark', 'spec', 'question', 'ledger', 'begin', 'plan', 'brief', 'accept', 'gate', 'close', 'init', 'clean', 'migrate', 'migrate-apply', 'migrate-github', 'start', 'stop', 'log'] },
    id: { type: 'string', description: 'The item id, as p12. For get: add that item in full.' },
    item: {
      type: ['object', 'string'],
      description: 'For add: the new item. For every other action that takes one: the item id, as p12.',
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
    full: { type: 'boolean', description: 'For get: the whole config, backlog and readiness instead of the slim answer.' },
    titles: { type: 'boolean', description: 'For get: add every item as id, status and title (the duplicate check).' },
    refresh: { type: 'boolean', description: 'For migrate and migrate-apply: go on although docs/pipeline/ exists; the apply then refreshes titles, sources and links and changes no status.' },
    config: { type: 'object', description: 'For migrate-apply: the corrected config, as migrate drafted it.' },
    items: { type: 'array', description: 'For migrate-apply: the corrected items in queue order (title, status, size, needs, source, spec, plan, pr, note; a building item with branch and resume), as migrate drafted them; needs may name the queue labels.', items: { type: 'object' } },
    close: { type: 'object', description: 'For brief: closes the dispatch before this one: { tokens, minutes, result }.' },
    tokens: { type: 'number', description: 'For accept and gate: the tokens of the Agent result.' },
    minutes: { type: 'number', description: 'For accept: the minutes of the Agent result.' },
    pr: { type: 'string', description: 'For close: the pull request, as #31, when the item does not carry it yet.' },
    force: { type: 'boolean', description: 'For close: close although the branch tip is not on origin/mainBranch (a squash merge). For begin and start with queue: github: take over here an issue another machine is building.' },
    fact: { type: 'string', description: 'For accept: one line a later implementer must know about working in this repository (a command\'s working spelling, a step that must come first); kept in docs/pipeline/facts.md and given to every brief.' },
    verdict: { type: 'string', description: 'For accept: how the task was approved. For gate: the final review\'s verdict.' },
    kind: { type: 'string', enum: ['implementer', 'fix', 'review', 'final'], description: 'For brief: which brief to render.' },
    task: { type: 'number', description: 'For brief: the task number (not for final).' },
    findings: { type: 'string', description: 'For brief: the findings, verbatim (required for fix; for a re-review or a second final review, its scope).' },
    carried: { type: 'string', description: 'For an implementer brief: minor findings carried from the previous task.' },
    commits: { type: 'string', description: 'For a review brief: the commit range, as <sha>..<sha>.' },
    attribution: { type: 'string', description: 'For plan or brief: the attribution lines this session was given; kept in the ledger, so once per item is enough.' },
    escalate: { type: 'boolean', description: 'For an implementer or fix brief: dispatch at config.models.escalate.' },
    rules: { type: 'array', description: 'For migrate-apply: the corrected rules, each { group, line, source }.', items: { type: 'object' } },
    text: { type: 'string', description: 'For spec: the spec, with the template\'s headings. For question: the question to ask on the issue.' },
    queue: { type: 'string', enum: ['file', 'github'], description: 'For init: github sets the project up with the issues as the queue.' },
    apply: { type: 'boolean', description: 'For migrate-github: move the file backlog onto issues; without it the action answers the draft and writes nothing.' },
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
const panel = atom({ plugin: 'pipeline', key: 'panel' } as const, { view: 'overview', filter: 'inbox', search: '', expanded: null, isMoreShown: false, autoOpenedFor: '', isBandOpen: false, isActivityOpen: false } as Panel)
// The clock the panel draws against: the ticker moves it, so minutes and the merged week stay current.
const now = atom({ plugin: 'pipeline', key: 'now' } as const, 0)

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// ---------- the panel ----------

/** The `autoOpen`, `band`, `idleStrip` and `tasks` settings as this load of the module received them. */
let isAutoOpen = true
let isCompactBand = false
let isIdleStrip = true
let isCompactTasks = false

async function openPane($: EngineInterface, focus = false): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: 'Pipeline', ...(focus ? { focus: true } : {}) })
}

/** The band's Panel button: opens the pane, or brings it forward with the keys when it is open. */
async function showPane($: EngineInterface): Promise<void> {
  try {
    await openPane($, await isPaneOpen($))
  } catch {}
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
    // The band's Panel button reads the pane's state when drawn: the atom write redraws it.
    const at = await $.clock.now()
    await update($, now, () => at)
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
  `Use the pipeline-intake skill for this request: "${text}". First tool call: ${call({ action: 'get', titles: true })} (the duplicate check: every item as id, status and title). Then add the item and write its spec as the skill says, and answer in one line. Never start the build.`

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
  `Pipeline clean, under the pipeline-rules skill. First tool call: ${call({ action: 'clean' })}. It lists, one per line, the paths config.retain says may go for every merged item, the superpowers folders of merged plans, the worktrees of merged items and their local branches as branch:<name>, and deletes nothing. ` +
  'From the main checkout on mainBranch: remove each listed path with `git rm -r -q` (plain `rm -r` for an untracked one; `git worktree remove` for a worktree; `git branch -D <name>` for a `branch:` line), commit the removals on mainBranch with the attribution lines this session was given and no model identifier, and answer one line with the counts, as `cleaned: 3 folders, 1 plan, 1 worktree, 1 branch`. An answer of `nothing to clean` is the one line, and nothing is committed.'

const QUEUE_PROMPT = (input: Record<string, unknown>) => `Under the pipeline-rules skill, make this one tool call: ${call(input)}. It answers one line; answer that line and nothing else.`

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
  // The merged-PR check: when origin/<mainBranch> was last fetched, and the items found merged with their Close pending.
  lastFetch: -Infinity,
  mergedPending: [] as MergedPending[],
  // The items this session was named after, so an item renames it once, and the name waiting for the turn's end.
  // The item this session runs: the last one it started, planned, briefed or wrote a ledger for.
  item: '',
  // How deep this session is inside its own locked actions: only the outermost takes the repository's lock.
  lockDepth: 0,
  // The lead's own model use since the ledger last recorded it: fresh tokens and the share read from cache.
  lead: { tokens: 0, cached: 0 },
  // What a redraw would read from disk again and again, kept for a few seconds.
  memo: new Map<string, { at: number; ref: unknown; value: unknown }>(),
  renamed: new Set<string>(),
  pendingRename: '',
  // The running child processes by item: the stream whose end kills the child, the unread tail of a line, the log throttle.
  procs: new Map<string, { stream: AsyncGenerator<{ stream: string; text: string }, { code: number | null; signal: string | null }> | null; partial: string; lastWrite: number }>(),
  // queue: github. The gh user, asked once per session; the readiness and the queue of the last load; the GitHub
  // updates the last write left pending (null when none ran); how deep this session is inside tool calls.
  me: '',
  readiness: {} as Record<string, Readiness>,
  queue: null as Queue | null,
  // When gh last failed in loadQueue and with what: for a minute after, loads answer from the cache without calling gh.
  ghDown: null as null | { at: number; error: string },
  ghPending: null as number | null,
  toolDepth: 0,
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

/** Reads the backlog file into its atom; with queue: github, the issues through their cache. Never throws in that mode. */
async function loadBacklog($: EngineInterface, found: string): Promise<Loaded<Backlog>> {
  const c = await read($, config)
  if (isGithub(c)) return loadIssueBacklog($, found, c)
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

// ---------- queue: github ----------

const ISSUES_FILE = '.git/pipeline/issues.json'
const ITEMS_FILE = '.git/pipeline/items.json'
const CACHE_MS = 60_000

/** What the issues answered: the issues the backlog maps (labelled, or with an entry in items.json), the extras, the gh user, how old the cache is when gh failed, the tracker's error when nothing could be read, and the in-flight ids that lost the queue label. */
type Queue = { issues: Issue[]; extras: Extras; me: string; stale: string | null; error: string | null; lost: string[] }
type IssueCache = { at: number; me: string; issues: Issue[] }

/** Whether the config says the issues are the queue. */
const isGithub = (c: Config | null): boolean => normalizeConfig(c ?? DEFAULTS).config.queue === 'github'
const labelOf = (c: Config | null): string => normalizeConfig(c ?? DEFAULTS).config.queueLabel

/** Where an item's records live in the configured queue mode: with queue: file, the docs/pipeline paths as before. Every record path in this file comes from here. */
const placesOf = (found: string, c: Config | null): Places => places(found, isGithub(c) ? 'github' : 'file')

/** A path under the main checkout as the checkout names it (`docs/pipeline/ledgers/p1.json`, `.git/pipeline/12/ledger.json`). */
const relOf = (found: string, path: string): string => (path.startsWith(`${found}/`) ? path.slice(found.length + 1) : path)

/** Makes sure .git/info/exclude ignores `.pipeline/`, the records' folder in every worktree; local, never committed. */
async function ensureExclude($: EngineInterface, found: string): Promise<void> {
  const exclude = places(found, 'github').exclude
  const had = (await readText($, exclude)) ?? ''
  if (!had.split('\n').some(l => l.trim() === '.pipeline/')) await $.fs.write(exclude, `${had}${had && !had.endsWith('\n') ? '\n' : ''}.pipeline/\n`)
}

/** The tracker's `run`: the argv through `$.process.run` in the main checkout; a thrown error (no gh) answers null. */
const ghRun = ($: EngineInterface, found: string): Run => async argv => {
  try {
    const r = await $.process.run(argv, { cwd: found, timeoutMs: 30_000 })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  } catch {
    return null
  }
}

/** The issue cache, or null when it is missing or not the tool's shape. */
async function readCache($: EngineInterface, found: string): Promise<IssueCache | null> {
  try {
    const loaded = await loadJson<IssueCache>($, places(found, 'github').issues, ISSUES_FILE)
    const v = loaded.value
    return v && typeof v.at === 'number' && typeof v.me === 'string' && Array.isArray(v.issues) ? v : null
  } catch {
    return null
  }
}

/** Changes the cached issues; without a cache, starts one that the next load lists again. */
async function editCache($: EngineInterface, found: string, change: (issues: Issue[]) => Issue[]): Promise<void> {
  const cache = await readCache($, found)
  await $.fs.write(places(found, 'github').issues, serialize({ at: cache?.at ?? 0, me: cache?.me ?? self.me, issues: change(cache?.issues ?? []) }))
}

/** items.json: missing reads as no extras; a file that does not parse gives its error and is never overwritten. */
async function readExtras($: EngineInterface, found: string): Promise<Loaded<Extras>> {
  const loaded = await loadJson<Partial<Extras>>($, places(found, 'github').items, ITEMS_FILE)
  if (loaded.error) return { value: null, error: loaded.error }
  const v = loaded.value
  const items = v && v.items && typeof v.items === 'object' && !Array.isArray(v.items) ? v.items : {}
  const pending = v && Array.isArray(v.pending) ? v.pending : []
  const leftover = (v && Array.isArray(v.leftover) ? v.leftover : []).filter(l => l && typeof l.id === 'string' && typeof l.worktree === 'string' && typeof l.branch === 'string')
  return { value: v ? { items, pending, ...(leftover.length ? { leftover } : {}) } : { ...EMPTY_EXTRAS, items: {}, pending: [] }, error: null }
}

async function extrasOrRefuse($: EngineInterface, found: string): Promise<Extras> {
  const ex = await readExtras($, found)
  if (ex.error || !ex.value) throw new Refused(ex.error ?? `${ITEMS_FILE} could not be read`)
  return ex.value
}

const writeExtras = ($: EngineInterface, found: string, extras: Extras) => $.fs.write(places(found, 'github').items, serialize(extras))

/**
 * The issues of the queue: the cache when it is younger than a minute; else the gh user (once per session) and the
 * labelled open issues, plus each issue items.json names that the list does not show, written back to the cache.
 * When gh fails the cache answers with its age, and without one the tracker's error is the answer.
 */
async function loadQueue($: EngineInterface, found: string, c: Config | null): Promise<Queue> {
  const label = labelOf(c)
  const ex = await readExtras($, found)
  if (ex.error || !ex.value) return { issues: [], extras: EMPTY_EXTRAS, me: self.me, stale: null, error: ex.error, lost: [] }
  const extras = ex.value
  const at = await $.clock.now()
  const cache = await readCache($, found)
  let issues: Issue[]
  let me: string
  let stale: string | null = null
  if (cache && at >= cache.at && at - cache.at < CACHE_MS) {
    issues = cache.issues
    me = cache.me || self.me
  } else {
    const run = ghRun($, found)
    // A minute after gh failed, it is not asked again: the redraws and the tick would each wait on it.
    const down = self.ghDown && at >= self.ghDown.at && at - self.ghDown.at < CACHE_MS ? self.ghDown : null
    const who: tracker.Result<string> = down ? { ok: false, error: down.error } : self.me ? { ok: true, value: self.me } : await tracker.me(run)
    const listed = who.ok ? await tracker.list(run, label) : who
    if (!who.ok || !listed.ok) {
      const error = !who.ok ? who.error : !listed.ok ? listed.error : ''
      if (!down) self.ghDown = { at, error }
      if (!cache) return { issues: [], extras, me: self.me, stale: null, error, lost: [] }
      issues = cache.issues
      me = cache.me || self.me
      stale = `issues read ${Math.max(0, Math.floor((at - cache.at) / 60_000))} min ago`
    } else {
      self.ghDown = null
      me = who.value
      issues = [...listed.value]
      for (const id of Object.keys(extras.items)) {
        if (!/^\d+$/.test(id) || issues.some(i => String(i.number) === id)) continue
        const one = await tracker.read(run, Number(id))
        const known = one.ok ? one.value : cache?.issues.find(i => String(i.number) === id)
        if (known) issues.push(known)
      }
      await $.fs.write(places(found, 'github').issues, serialize({ at, me, issues }))
    }
  }
  self.me = me
  const shown = issues.filter(i => i.labels.includes(label) || extras.items[String(i.number)] !== undefined)
  const lost = shown.filter(i => i.state === 'open' && !i.labels.includes(label)).map(i => String(i.number))
  return { issues: shown, extras, me, stale, error: null, lost }
}

/**
 * Runs the tracker operations; the ones that succeed go into the cache, the ones that fail are appended to the
 * pending list in items.json. Answers how many are pending.
 */
async function pushOps($: EngineInterface, found: string, c: Config | null, ops: Op[]): Promise<number> {
  const extras = await extrasOrRefuse($, found)
  const run = ghRun($, found)
  const cache = await readCache($, found)
  const me = cache?.me || self.me
  const done: Op[] = []
  const failed: Op[] = []
  for (const op of ops) {
    let r: tracker.Result<true>
    if (op.kind === 'edit') {
      r = await tracker.edit(run, Number(op.id), { add: op.add, remove: op.remove, ...(op.assign ? { assign: op.assign } : {}) })
    } else if (op.kind === 'status') {
      const issue = cache?.issues.find(i => String(i.number) === op.id)
      const spec = issue ? specCommentOf(issue, me) : null
      // No spec comment to rewrite: there is nothing to say the status on.
      if (!spec || !spec.id) continue
      r = await tracker.editComment(run, spec.id, renderSpecComment(parseSpecComment(spec.body).specMd, op.state, op.detail))
    } else {
      r = await tracker.close(run, Number(op.id))
    }
    ;(r.ok ? done : failed).push(op)
  }
  if (cache && done.length) await $.fs.write(places(found, 'github').issues, serialize({ ...cache, issues: applyOps(cache.issues, done, labelOf(c), me) }))
  const pending = [...extras.pending, ...failed]
  await writeExtras($, found, { ...extras, pending })
  self.ghPending = pending.length
  return pending.length
}

/** The backlog the issues make, kept with its readiness; an answered question's label is taken off. */
async function loadIssueBacklog($: EngineInterface, found: string, c: Config | null): Promise<Loaded<Backlog>> {
  try {
    const q = await loadQueue($, found, c)
    self.queue = q
    if (q.error) {
      self.readiness = {}
      await update($, backlog, () => null)
      return { value: null, error: q.error }
    }
    const label = labelOf(c)
    // The updates still pending show as done: the cache keeps what GitHub said, the backlog what the tool left.
    const mapped = toBacklog(applyOps(q.issues, q.extras.pending, label, q.me), q.extras, label, q.me)
    self.readiness = mapped.readiness
    const needsInfo = labelsOf(label).needsInfo
    // Once per answer: an op already pending is not queued again by every redraw.
    const ops: Op[] = mapped.answered
      .filter(id => !q.extras.pending.some(o => o.kind === 'edit' && o.id === id && o.remove.includes(needsInfo)))
      .map(id => ({ kind: 'edit', id, add: [], remove: [needsInfo] }))
    if (ops.length) await pushOps($, found, c, ops)
    await update($, backlog, () => mapped.backlog)
    return { value: mapped.backlog, error: null }
  } catch (err) {
    self.readiness = {}
    await update($, backlog, () => null)
    return { value: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Retries what is pending, turns the change from the loaded backlog to `next` into tracker operations, keeps the extras. */
async function writeIssueBacklog($: EngineInterface, found: string, c: Config | null, next: Backlog): Promise<{ backlog: Backlog; readiness: Record<string, Readiness> }> {
  const label = labelOf(c)
  const q = await loadQueue($, found, c)
  if (q.error) throw new Refused(q.error)
  const before = (await read($, backlog)) ?? toBacklog(q.issues, q.extras, label, q.me).backlog
  if (q.extras.pending.length) {
    await writeExtras($, found, { ...q.extras, pending: [] })
    await pushOps($, found, c, q.extras.pending)
  }
  const issues = (await readCache($, found))?.issues ?? q.issues
  await pushOps($, found, c, opsFor(before, next, issues, label, q.me))
  const kept = extrasOf(next, await extrasOrRefuse($, found))
  await writeExtras($, found, kept)
  const after = ((await readCache($, found))?.issues ?? issues).filter(i => i.labels.includes(label) || kept.items[String(i.number)] !== undefined)
  self.readiness = toBacklog(applyOps(after, kept.pending, label, q.me), kept, label, q.me).readiness
  await update($, backlog, () => next)
  await update($, fileError, () => null)
  return { backlog: next, readiness: self.readiness }
}

/** An item's one-line state after a GitHub action changed its issue: the backlog loaded again from the cache. */
async function issueState($: EngineInterface, found: string, id: string, fallback: string): Promise<string> {
  const b = (await loadBacklog($, found)).value
  const item = b?.items.find(i => i.id === id)
  return item ? itemState(item, self.readiness) : fallback
}

/** `add`: a labelled issue; the cache takes it. */
async function addIssue($: EngineInterface, found: string, c: Config | null, e: ToolInput): Promise<string> {
  const title = typeof e.item === 'string' ? undefined : e.item?.title?.trim()
  if (!title) throw new Refused('add needs item.title')
  const body = typeof e.item === 'string' ? '' : (e.item?.note ?? '')
  const r = await tracker.create(ghRun($, found), { title, body, labels: [labelOf(c)] })
  if (!r.ok) throw new Refused(r.error)
  const n = r.value
  const at = await nowIso($)
  await editCache($, found, issues => [...issues.filter(i => i.number !== n), { number: n, title, body, author: self.me, labels: [labelOf(c)], assignees: [], state: 'open', url: '', createdAt: at, comments: [] }])
  return `added ${n} · ${await issueState($, found, String(n), 'inbox · no spec')}`
}

/** `spec`: edits the spec comment (its state and detail kept) or posts one as ready; rewrites the worktree's spec.md. */
async function specIssue($: EngineInterface, found: string, id: string, e: ToolInput): Promise<string> {
  const body = typeof e.text === 'string' ? e.text : ''
  if (!body.trim()) throw new Refused('spec needs text')
  const run = ghRun($, found)
  const me = self.me
  const issue = (await readCache($, found))?.issues.find(i => String(i.number) === id) ?? self.queue?.issues.find(i => String(i.number) === id)
  const old = issue ? specCommentOf(issue, me) : null
  const at = await nowIso($)
  if (old) {
    const was = parseSpecComment(old.body)
    const rendered = renderSpecComment(body, was.state || 'ready', was.detail)
    const r = await tracker.editComment(run, old.id, rendered)
    if (!r.ok) throw new Refused(r.error)
    await editCache($, found, issues => issues.map(i => (String(i.number) === id ? { ...i, comments: i.comments.map(cm => (cm.id === old.id ? { ...cm, body: rendered } : cm)) } : i)))
  } else {
    const rendered = renderSpecComment(body, 'ready', '')
    const r = await tracker.comment(run, Number(id), rendered)
    if (!r.ok) throw new Refused(r.error)
    await editCache($, found, issues => issues.map(i => (String(i.number) === id ? { ...i, comments: [...i.comments, { id: r.value, author: me, association: '', body: rendered, at }] } : i)))
  }
  const P = places(found, 'github')
  const ledger = (await loadJson<Ledger>($, P.ledger(id), `.git/pipeline/${id}/ledger.json`)).value
  if (ledger && typeof ledger.worktree === 'string' && ledger.worktree) await $.fs.write(`${worktreePath(found, ledger)}/${P.specRel(id)}`, body)
  return `${id} · ${await issueState($, found, id, 'ready')} · spec posted`
}

/** `question`: a marked comment on the issue and the needs-info label. */
async function questionIssue($: EngineInterface, found: string, c: Config | null, id: string, e: ToolInput): Promise<string> {
  const question = typeof e.text === 'string' ? e.text.trim() : ''
  if (!question) throw new Refused('question needs text')
  const posted = `${QUESTION_MARK}\n${question}`
  const r = await tracker.comment(ghRun($, found), Number(id), posted)
  if (!r.ok) throw new Refused(r.error)
  const at = await nowIso($)
  await editCache($, found, issues => issues.map(i => (String(i.number) === id ? { ...i, comments: [...i.comments, { id: r.value, author: self.me, association: '', body: posted, at }] } : i)))
  await pushOps($, found, c, [{ kind: 'edit', id, add: [labelsOf(labelOf(c)).needsInfo], remove: [] }])
  return `${id} · ${await issueState($, found, id, 'inbox · open question on the issue')}`
}

/** `unpark`: the issue is not in the list; read it, refuse a closed one, put the queue label back. */
async function unparkIssue($: EngineInterface, found: string, c: Config | null, current: Backlog, id: string | undefined): Promise<string> {
  if (!id) throw new Refused('an id is needed')
  const there = current.items.find(i => i.id === id)
  if (there) throw new Refused(`${id} is ${there.status}, not parked`)
  if (!/^\d+$/.test(id)) throw new Refused(`no item ${id}`)
  const r = await tracker.read(ghRun($, found), Number(id))
  if (!r.ok) throw new Refused(r.error)
  if (r.value.state === 'closed') throw new Refused(`${id} is closed`)
  await editCache($, found, issues => [...issues.filter(i => i.number !== r.value.number), r.value])
  await pushOps($, found, c, [{ kind: 'edit', id, add: [labelOf(c)], remove: [] }])
  return `${id} · ${await issueState($, found, id, 'inbox')}`
}

/** One issue read fresh from GitHub (not the cache), written into the cache so the backlog mapped next is true; refused when gh fails. */
async function readIssue($: EngineInterface, found: string, id: string): Promise<Issue> {
  const r = await tracker.read(ghRun($, found), Number(id))
  if (!r.ok) throw new Refused(r.error)
  await editCache($, found, issues => [...issues.filter(i => i.number !== r.value.number), r.value])
  return r.value
}

/**
 * The issue read fresh before `begin` or `start` makes a worktree for it. Refused when it carries the building label and
 * this machine has no ledger for it (another machine builds it, of another user or of this one: one login) unless
 * forced, and when it has no spec comment. Answers the issue and the spec its comment holds.
 */
async function claimIssue($: EngineInterface, found: string, c: Config | null, id: string, hasLedger: boolean, force: boolean): Promise<{ issue: Issue; specMd: string }> {
  const issue = await readIssue($, found, id)
  if (issue.labels.includes(labelsOf(labelOf(c)).building) && !hasLedger && !force) {
    const other = issue.assignees.find(a => a !== self.me)
    throw new Refused(`${id} is being built ${other ? `elsewhere (by @${other})` : 'on another machine of yours'} · to take it over here: begin with "force": true`)
  }
  const spec = specCommentOf(issue, self.me)
  if (!spec) throw new Refused(`${id} has no spec comment: post one with spec`)
  return { issue, specMd: parseSpecComment(spec.body).specMd }
}

/** `init` with queue: github: gh must answer for this repository; the config, the labels and the exclude line, no backlog. */
async function initGithub($: EngineInterface, found: string, c: Config | null, error: string | null): Promise<string> {
  const p = paths(found)
  const hasConfig = await $.fs.exists(p.config)
  if (hasConfig && error) throw new Refused(error)
  if (hasConfig && !isGithub(c)) throw new Refused(`${CONFIG_FILE} exists with queue: file; set it with /pipeline config queue=github`)
  const next = hasConfig ? normalizeConfig(c).config : { ...structuredClone(DEFAULTS), queue: 'github' as const }
  const run = ghRun($, found)
  const who = self.me ? ({ ok: true, value: self.me } as const) : await tracker.me(run)
  if (!who.ok) throw new Refused(who.error)
  self.me = who.value
  const listed = await tracker.list(run, next.queueLabel)
  if (!listed.ok) throw new Refused(listed.error)
  if (!hasConfig) {
    await $.fs.write(p.config, serialize(next))
    await update($, config, () => structuredClone(next))
  }
  const L = labelsOf(next.queueLabel)
  const names = [L.queue, L.building, L.blocked, L.needsInfo]
  const labelled = await tracker.ensureLabels(run, names)
  if (!labelled.ok) throw new Refused(labelled.error)
  await ensureExclude($, found)
  await update($, fileError, () => null)
  const head = hasConfig ? `exists: ${CONFIG_FILE}` : `wrote ${CONFIG_FILE}`
  return `${head} · labels ${names.join(', ')}${hasConfig ? '' : ` · commit ${CONFIG_FILE} on ${next.mainBranch}`}`
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
  if (isGithub(await read($, config))) return self.readiness
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
  full?: boolean
  titles?: boolean
  config?: unknown
  items?: unknown
  rules?: unknown
  kind?: string
  task?: number
  findings?: string
  carried?: string
  commits?: string
  attribution?: string
  escalate?: boolean
  close?: { tokens?: number; minutes?: number; result?: string }
  tokens?: number
  minutes?: number
  verdict?: string
  review?: string
  fact?: string
  pr?: string
  force?: boolean
  text?: string
  queue?: string
  apply?: boolean
}

class Refused extends Error {}

async function nowIso($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

/** The ledger of an item as it is on disk, where the queue mode keeps it: missing gives null, bad JSON gives the error with its line. */
async function readLedger($: EngineInterface, found: string, id: string): Promise<Loaded<Ledger>> {
  const file = placesOf(found, await read($, config)).ledger(id)
  return loadJson<Ledger>($, file, relOf(found, file))
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
    // A resume block an earlier version saved from text, one character per key, reads as that text again.
    const resume = repairResume(set.resume, Math.max(1, lists.tasks.length))
    return mergeLedger(emptyLedger(id), { ...set, ...lists, ...(resume ? { resume } : {}) }, await nowIso($))
  } catch {
    return null
  }
}

/** Everything the status text and the panel draw from, for the files as given. */
/**
 * A value a redraw would read from disk again, kept for `ttlMs` while `ref` (the backlog the atom holds) is the same
 * object. The panel and the band redraw on every step of a subagent; the tool's own answers never go through here.
 */
async function memo<T>($: EngineInterface, key: string, ref: unknown, ttlMs: number, make: () => Promise<T>): Promise<T> {
  const at = await $.clock.now()
  const hit = self.memo.get(key)
  if (hit && hit.ref === ref && at - hit.at < ttlMs && at >= hit.at) return hit.value as T
  const value = await make()
  self.memo.set(key, { at, ref, value })
  return value
}
const DRAW_TTL_MS = 3000
const drawnLedger = ($: EngineInterface, found: string, id: string) => memo($, `ledger:${id}`, null, DRAW_TTL_MS, () => loadLedger($, found, id))

async function gather($: EngineInterface, found: string, c: Config | null, b: Backlog | null, error: string | null, isDraw = false): Promise<StatusInput> {
  const active = await activeItem($, b)
  return {
    activeId: active?.id ?? null,
    config: c,
    backlog: b,
    readiness: !b ? {} : isDraw ? await memo($, 'readiness', b, 10_000, () => judgeAll($, found, b)) : await judgeAll($, found, b),
    ledger: !active ? null : isDraw ? await drawnLedger($, found, active.id) : await loadLedger($, found, active.id),
    agents: await read($, agents),
    signals: await read($, signals),
    now: await $.clock.now(),
    fileError: error,
    mergedPending: self.mergedPending,
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

/** The listing `cleanList` wants: the known parents, the superpowers pointers, the worktree names, the local branches and the merged items' ledger branches. With queue: github the records are not in the repository: only the worktrees. */
async function cleanInput($: EngineInterface, found: string, b: Backlog | null): Promise<{ listing: string[]; planPaths: Record<string, string>; worktrees: string[]; branches: string[]; ledgerBranches: Record<string, string> }> {
  const gh = isGithub(await read($, config))
  const ledgers = relOf(found, paths(found).ledgers)
  const plans = relOf(found, paths(found).plans)
  const listing: string[] = []
  for (const parent of gh ? ['.claude/worktrees'] : [ledgers, plans, '.superpowers/sdd', '.claude/worktrees']) {
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
  for (const item of gh ? [] : b?.items ?? []) {
    if (item.status !== 'merged') continue
    const plan = planOf(item)
    if (!plan.startsWith(`${plans}/`) && (await readText($, `${found}/${plan}`)) !== null) listing.push(plan)
  }
  const worktrees = listing.filter(p => p.startsWith('.claude/worktrees/') && p.endsWith('/')).map(p => p.slice('.claude/worktrees/'.length, -1))
  // The local branches, so a merged item's branch is listed as `branch:<name>` for the caller's `git branch -D`; none when git fails.
  let branches: string[] = []
  try {
    const r = await $.process.run(['git', '-C', found, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { cwd: found, timeoutMs: 30_000 })
    if (r.exitCode === 0) branches = r.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  } catch {}
  const ledgerBranches: Record<string, string> = {}
  for (const item of b?.items ?? []) {
    if (item.status !== 'merged' || (typeof item.branch === 'string' && item.branch)) continue
    const branch = (await loadLedger($, found, item.id))?.branch
    if (typeof branch === 'string' && branch) ledgerBranches[item.id] = branch
  }
  return { listing, planPaths, worktrees, branches, ledgerBranches }
}

/**
 * The items whose PR was merged by hand while their Close never ran: every `review` item, and every `building` item
 * with a `pr`, whose branch tip is on `origin/<mainBranch>` (fetched at most once per minute per session). The git
 * calls run through `$.process.run`; a failed one reads as unknown, not merged. The result is kept for the status
 * block and the panel, which never run git themselves.
 */
async function checkMerged($: EngineInterface, found: string, c: Config | null, b: Backlog | null): Promise<MergedPending[]> {
  try {
    const ledgers: Record<string, Ledger | null> = {}
    for (const item of b?.items ?? []) {
      if (item.status === 'review' || item.status === 'building') ledgers[item.id] = await loadLedger($, found, item.id)
    }
    const list = mergeCandidates(b, ledgers)
    if (!list.length) {
      self.mergedPending = []
      return []
    }
    const mainBranch = c?.mainBranch ?? DEFAULTS.mainBranch
    const git: Git = async argv => {
      try {
        const r = await $.process.run(argv, { cwd: found, timeoutMs: 60_000 })
        return { exitCode: r.exitCode }
      } catch {
        return null
      }
    }
    const at = await $.clock.now()
    if (isFetchDue(self.lastFetch, at)) {
      self.lastFetch = at
      await git(fetchArgv(found, mainBranch))
    }
    self.mergedPending = await findMerged(found, list, mainBranch, git)
  } catch {}
  return self.mergedPending
}

/** Writes the backlog and its generated view, refreshes the atom and answers what was written, settled, with its readiness. */
async function writeBacklog($: EngineInterface, found: string, next: Backlog): Promise<{ backlog: Backlog; readiness: Record<string, Readiness> }> {
  const c = await read($, config)
  if (isGithub(c)) return writeIssueBacklog($, found, c, next)
  const p = paths(found)
  // Settling moves items between inbox and ready only, so the judgement holds for the settled backlog too.
  const judged = await judgeAll($, found, next)
  const settled = settle(next, judged, await nowIso($))
  await $.fs.write(p.backlog, serialize(settled))
  await $.fs.write(p.backlogMd, renderBacklogMd(settled))
  await update($, backlog, () => settled)
  await update($, fileError, () => null)
  return { backlog: settled, readiness: judged }
}

/** A backlog write's one-line answer: the item's id, what changed and its status after the write. */
async function writeLine($: EngineInterface, found: string, next: Backlog, id: string, what: (state: string) => string): Promise<string> {
  const written = await writeBacklog($, found, next)
  const item = written.backlog.items.find(i => i.id === id)
  return what(item ? itemState(item, written.readiness) : 'gone')
}

/** Marks every open signal delivered: an answer carried them. */
async function markDelivered($: EngineInterface): Promise<void> {
  await update($, signals, list => list.map(s => (s.delivered ? s : { ...s, delivered: true })))
  await heartbeat($, true)
}

/** The actions that change the backlog or a ledger: each runs alone across every session on the repository. */
const LOCKED_ACTIONS = new Set(['add', 'update', 'move', 'remove', 'park', 'unpark', 'ledger', 'begin', 'plan', 'brief', 'accept', 'close', 'start', 'stop', 'init', 'migrate-apply', 'migrate-github', 'spec', 'question'])
const LOCK_WAIT_MS = 250
const LOCK_TRIES = 120

const pause = ($: EngineInterface, ms: number) => new Promise<void>(resolve => void $.clock.after(ms, () => resolve()))

/**
 * Runs `work` holding the repository's pipeline lock: a folder under .git that only one `mkdir` can create, so two
 * sessions never read and write the backlog at once. It waits for another holder up to thirty seconds, then takes
 * the lock over (its holder died). Where there is no repository, or no `mkdir`, the work runs unlocked, as before.
 */
async function withLock<T>($: EngineInterface, found: string, work: () => Promise<T>): Promise<T> {
  if (self.lockDepth > 0 || !self.hasRepo) return work()
  const dir = `${found}/.git/pipeline.lock`
  const make = async (): Promise<'held' | 'busy' | 'none'> => {
    try {
      const r = await $.process.run(['mkdir', dir], { cwd: found, timeoutMs: 10_000 })
      if (r.exitCode === 0) return 'held'
      return (await $.fs.exists(dir)) ? 'busy' : 'none'
    } catch {
      return 'none'
    }
  }
  let state = await make()
  for (let i = 0; state === 'busy' && i < LOCK_TRIES; i++) {
    await pause($, LOCK_WAIT_MS)
    state = await make()
  }
  if (state === 'busy') {
    // Thirty seconds: no action holds it that long, so its holder is gone.
    try {
      await $.process.run(['rmdir', dir], { cwd: found, timeoutMs: 10_000 })
    } catch {}
    state = await make()
  }
  self.lockDepth++
  try {
    return await work()
  } finally {
    self.lockDepth--
    if (state === 'held') {
      try {
        await $.process.run(['rmdir', dir], { cwd: found, timeoutMs: 10_000 })
      } catch {}
    }
  }
}

async function runTool($: EngineInterface, e: ToolInput): Promise<string> {
  const isOuter = self.toolDepth === 0
  if (isOuter) self.ghPending = null
  self.toolDepth++
  try {
    let answer: string
    if (LOCKED_ACTIONS.has(e.action) && self.lockDepth === 0) {
      const root = await resolveRoot($)
      answer = await withLock($, root, () => runToolNow($, e))
    } else {
      answer = await runToolNow($, e)
    }
    return isOuter && LOCKED_ACTIONS.has(e.action) ? withPending(answer, self.ghPending) : answer
  } finally {
    self.toolDepth--
  }
}

/** A writing action's answer with the GitHub updates still pending at the end of its first line. */
function withPending(answer: string, pending: number | null): string {
  if (!pending) return answer
  const [first = '', ...rest] = answer.split('\n')
  return [`${first} · ${pending} GitHub update${pending === 1 ? '' : 's'} pending`, ...rest].join('\n')
}

/** The refusal of an action the issues make meaningless. */
const notWithIssues = (action: string) => `${action} does not apply with queue: github: the issues are the queue`

async function runToolNow($: EngineInterface, e: ToolInput): Promise<string> {
  const found = await resolveRoot($)
  const { config: c, backlog: loaded, error } = await loadAll($, found)
  const p = paths(found)

  if (e.action === 'init' && (e.queue === 'github' || isGithub(c))) return initGithub($, found, c, error)
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
    return `wrote ${wrote.join(', ')}\n${commitLine(c?.mainBranch ?? DEFAULTS.mainBranch)}`
  }
  if (e.action === 'status') {
    if (e.id === undefined) return statusNow($, found, c, loaded, error)
    const item = loaded?.items.find(i => i.id === e.id) ?? null
    if (!item) return `no item ${e.id}`
    const ledger = await readLedger($, found, item.id)
    if (ledger.error) return `${[item.id, item.title, item.status].join(' · ')}\n${ledger.error}`
    return ledger.value ? ledgerText((await loadLedger($, found, item.id)) ?? ledger.value, item) : `${[item.id, item.title, item.status].join(' · ')}\nno ledger`
  }
  if (e.action === 'get') {
    const r = loaded ? await judgeAll($, found, loaded) : {}
    const open = (await read($, signals)).filter(s => !s.delivered)
    // The active item is the one in planning, building or review; resume is null until its ledger has the block.
    const active = await activeItem($, loaded)
    const ledger = active ? await loadLedger($, found, active.id) : null
    // A child's record without its log (up to 200 KB each): `log { item }` answers the text.
    const kids = (await read($, children)).map(({ log: _log, ...rest }) => rest)
    // A PR merged by hand: the item's Close is pending, and the run skill does it first.
    const merged = await checkMerged($, found, c, loaded)
    let answer: string
    if (e.full) {
      const out: Record<string, unknown> = { config: isGithub(c) ? githubConfig(c) : c, backlog: loaded, readiness: r, active: active?.id ?? null, resume: ledger?.resume ?? null, signals: open, children: kids, siblings: await read($, siblings), mergedPending: merged }
      if (error) out['error'] = error
      if (isGithub(c)) Object.assign(out, githubGet(c, e.id))
      answer = JSON.stringify(out, null, 2)
    } else {
      const out: Record<string, unknown> = slimGet({ config: c ? normalizeConfig(c).config : null, backlog: loaded, readiness: r, active, ledger, signals: open, children: kids, siblings: await read($, siblings) })
      if (e.id !== undefined) {
        const one = loaded?.items.find(i => i.id === e.id) ?? null
        out['item'] = one ? { ...one, ...(r[one.id] ? { readiness: r[one.id] } : {}) } : null
      }
      if (e.titles) out['titles'] = (loaded?.items ?? []).map(i => `${i.id} ${i.status} ${i.title}`)
      if (merged.length) out['mergedPending'] = merged
      if (error) out['error'] = error
      if (isGithub(c)) Object.assign(out, githubGet(c, e.id))
      answer = JSON.stringify(out)
    }
    // Each signal is delivered once: what this answer carries is marked.
    if (open.length) await markDelivered($)
    return answer
  }
  if (e.action === 'signals') {
    const open = (await read($, signals)).filter(s => !s.delivered)
    const merged = await checkMerged($, found, c, loaded)
    const lost = isGithub(c) ? lostLines(c) : []
    if (lost.length) {
      if (open.length) await markDelivered($)
      return JSON.stringify({ signals: open.map(compactSignal), lost, ...(merged.length ? { mergedPending: merged } : {}) })
    }
    if (!open.length && !merged.length) return 'no signals'
    const answer = merged.length ? JSON.stringify({ signals: open.map(compactSignal), mergedPending: merged }) : JSON.stringify(open.map(compactSignal))
    if (open.length) await markDelivered($)
    return answer
  }
  if (e.action === 'clean') {
    if (error) throw new Refused(error)
    const id = typeof e.item === 'string' ? e.item : e.item?.id ?? e.id
    // queue: github: what a close had to leave, for a closed issue the backlog no longer holds.
    const left = isGithub(c) ? await leftoverLines($, found, id) : []
    if (id !== undefined && !left.length) {
      const item = loaded?.items.find(i => i.id === id)
      if (!item) throw new Refused(`no item ${id}`)
      if (item.status !== 'merged') throw new Refused(`${id} is ${item.status}, not merged`)
    }
    const listed = cleanList({ config: c, backlog: loaded, ...(id !== undefined ? { item: id } : {}), ...(isGithub(c) ? { queue: 'github' as const } : {}), ...(await cleanInput($, found, loaded)) })
    const list = [...listed, ...left.filter(x => !listed.includes(x))]
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
  if (e.action === 'migrate-github') return migrateGithub($, found, c, loaded, error, e)

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
      const ledgerPath = placesOf(found, c).ledger(id)
      const ledgerFile = relOf(found, ledgerPath)
      const onDisk = await readLedger($, found, id)
      if (onDisk.error) throw new Refused(onDisk.error)
      // A ledger file the item does not link is a leftover of a removed item: never merged into silently.
      const linked = current.items.find(i => i.id === id)?.ledger
      if (onDisk.value && (linked === null || linked === undefined)) {
        throw new Refused(`${ledgerFile} exists but ${id} has no ledger link: a stale file of an earlier item; move or delete it, or link it with update { id: "${id}", set: { ledger: "${ledgerFile}" } }`)
      }
      // A wrong shape is refused before anything is written; what was plainly meant (text for the resume state) is kept.
      const base = onDisk.value ?? emptyLedger(id)
      const shaped = shapeSet(set as Record<string, unknown>, { resume: repairResume(base.resume, Math.max(1, base.tasks?.length ?? 1)), tasks: base.tasks ?? [] })
      if (shaped.problems.length) throw new Refused(`ledger ${id} not written: ${shaped.problems.join('; ')}`)
      const merged = mergeLedger({ ...base, ...(base.resume ? { resume: repairResume(base.resume, Math.max(1, base.tasks?.length ?? 1))! } : {}) }, shaped.set, now)
      await $.fs.write(ledgerPath, serialize(merged))
      self.memo.delete(`ledger:${id}`)
      // The item points at its ledger, and carries the branch, PR and plan the ledger names.
      const item = current.items.find(i => i.id === id)!
      const mirror: Partial<Item> = {}
      if (item.ledger !== ledgerFile) mirror.ledger = ledgerFile
      for (const k of ['branch', 'pr', 'plan'] as const) if (typeof set[k] === 'string' && item[k] !== set[k]) mirror[k] = set[k] as string
      if (Object.keys(mirror).length) await writeBacklog($, found, updateItem(current, id, mirror, now))
      return ledgerLine(merged)
    }
    case 'begin':
      return beginAction($, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'accept':
      return acceptAction($, found, c, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'close':
      return closeAction($, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'gate':
      return gateAction($, found, c, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'plan':
      return planAction($, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'brief':
      return briefAction($, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'add': {
      if (isGithub(c)) return addIssue($, found, c, e)
      const title = typeof e.item === 'string' ? undefined : e.item?.title?.trim()
      if (!title) throw new Refused('add needs item.title')
      const next = addItem(current, { ...(e.item as Partial<Item>), title }, now)
      const id = next.items[next.items.length - 1]!.id
      return writeLine($, found, next, id, state => `added ${id} · ${state}`)
    }
    case 'update': {
      const id = need(e.id)
      if (!e.set || typeof e.set !== 'object') throw new Refused('update needs set')
      const before = current.items.find(i => i.id === id)
      const next = updateItem(current, id, e.set as Partial<Item>, now)
      const others = Object.keys(e.set).filter(k => k !== 'status')
      const out = await writeLine($, found, next, id, state => [id, state, ...(others.length ? [`set ${others.join(', ')}`] : [])].join(' · '))
      const after = next.items.find(i => i.id === id)
      if (before && after && startsRun(before.status, after.status)) await queueRename($, c, after)
      return out
    }
    case 'move': {
      if (isGithub(c)) throw new Refused(notWithIssues('move'))
      const id = need(e.id)
      const to = e.to
      if (to !== 'top' && !(to && typeof to === 'object' && typeof to.after === 'string')) throw new Refused('move needs to: "top" or { after: "<id>" }')
      if (to !== 'top') need(to.after)
      return writeLine($, found, moveItem(current, id, to), id, state => `${id} · moved ${to === 'top' ? 'to the top' : `after ${to.after}`} · ${state}`)
    }
    case 'start':
      return startChild($, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e.force === true)
    case 'stop':
      return stopChild($, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id))
    case 'remove': {
      if (isGithub(c)) throw new Refused(notWithIssues('remove'))
      const id = need(e.id)
      const left = (await writeBacklog($, found, removeItem(current, id))).backlog.items.length
      return `removed ${id} · ${left} item${left === 1 ? '' : 's'} left`
    }
    case 'park': {
      const id = need(e.id)
      return writeLine($, found, updateItem(current, id, { status: 'parked' }, now), id, state => `${id} · ${state}`)
    }
    case 'unpark': {
      if (isGithub(c)) return unparkIssue($, found, c, current, e.id)
      const id = need(e.id)
      return writeLine($, found, updateItem(current, id, { status: 'inbox' }, now), id, state => `${id} · ${state}`)
    }
    case 'spec':
    case 'question': {
      if (!isGithub(c)) throw new Refused(`${e.action} is for queue: github; with queue: file the spec is a file and a question its Open section`)
      const id = need(e.id)
      return e.action === 'spec' ? specIssue($, found, id, e) : questionIssue($, found, c, id, e)
    }
    default:
      throw new Refused(`unknown action "${String(e.action)}"`)
  }
}

/** The keys `get` adds with queue: github: how old the issues are when gh failed, the issues that lost the label, the quoted issue. */
function githubGet(c: Config | null, id: string | undefined): Record<string, unknown> {
  const q = self.queue
  const out: Record<string, unknown> = {}
  if (q?.stale) out['stale'] = q.stale
  const lost = lostLines(c)
  if (lost.length) out['lost'] = lost
  const issue = id !== undefined ? q?.issues.find(i => String(i.number) === id) : undefined
  if (issue) out['quoted'] = quoted(issue, q!.me)
  return out
}

/**
 * The config as `get` answers it with queue: github: an afterMerge entry under docs/pipeline/ has nothing to act on
 * (no BACKLOG.md, no record on mainBranch), so it is left out; pushMain and retain are not read in this mode.
 */
function githubConfig(c: Config | null): Config | null {
  if (!c) return c
  const recordsDir = `${places('', 'file').recordsDir}/`
  return { ...c, afterMerge: normalizeConfig(c).config.afterMerge.filter(x => !x.replace(/^\.?\/+/, '').startsWith(recordsDir)) }
}

/** `<id> lost the <label> label` for each issue in flight that is open without the queue label. */
const lostLines = (c: Config | null): string[] => (self.queue?.lost ?? []).map(id => `${id} lost the ${labelOf(c)} label`)

const BRIEF_KINDS: readonly string[] = ['implementer', 'fix', 'review', 'final']

/** The item's worktree as an absolute path: the ledger's, under the main checkout when relative; the main checkout without one. */
const worktreePath = (found: string, ledger: Ledger | null): string => {
  const w = typeof ledger?.worktree === 'string' ? slashes(ledger.worktree) : ''
  return !w ? found : /^(?:\/|[A-Za-z]:)/.test(w) ? w : `${found}/${w}`
}

/** A file of the item, read from its worktree first and from the main checkout otherwise. */
async function readItemFile($: EngineInterface, found: string, wt: string, rel: string): Promise<string | null> {
  return (await readText($, `${wt}/${rel}`)) ?? (wt === found ? null : await readText($, `${found}/${rel}`))
}

/** One git answer in the worktree, trimmed; null when git fails. */
async function gitOut($: EngineInterface, wt: string, args: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(['git', '-C', wt, ...args], { cwd: wt, timeoutMs: 30_000 })
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

/** The plan of an item, parsed and sound, or refused with the format or the problems. */
async function loadPlan($: EngineInterface, found: string, wt: string, id: string, ledger: Ledger | null) {
  const rel = typeof ledger?.plan === 'string' && ledger.plan ? ledger.plan : placesOf(found, await read($, config)).planRel(id)
  const text = await readItemFile($, found, wt, rel)
  if (text === null) throw new Refused(`no plan at ${rel}; write it in this format, then call plan again:\n\n${PLAN_FORMAT}`)
  const plan = parsePlan(text)
  const problems = checkPlan(plan)
  if (problems.length) throw new Refused(`${rel} cannot be built:\n${problems.map(x => `- ${x}`).join('\n')}\n\nThe format:\n\n${PLAN_FORMAT}`)
  return { plan, rel }
}

/** A brief's answer without its leading item id, for joining onto another answer. */
const withoutId = (id: string, line: string) => (line.startsWith(`${id} · `) ? line.slice(id.length + 3) : line)

const FACTS_MAX = 12

/**
 * What a run learned about working in this repository (a command's working spelling, a step that must come first):
 * one line per fact in the facts file of the queue mode, the newest twelve kept, given to every implementer and reviewer.
 */
async function addFact($: EngineInterface, found: string, fact: string): Promise<void> {
  const line = fact.replace(/\s+/g, ' ').trim().slice(0, 240)
  if (!line) return
  const path = placesOf(found, await read($, config)).facts
  const lines = ((await readText($, path)) ?? '').split('\n').map(l => l.replace(/^[-*]\s+/, '').trim()).filter(l => l && !l.startsWith('#'))
  if (lines.some(l => l.toLowerCase() === line.toLowerCase())) return
  const kept = [...lines, line].slice(-FACTS_MAX)
  await $.fs.write(path, `# Facts\n\nWhat runs learned about working in this repository; the tool keeps the newest ${FACTS_MAX} and gives them to every brief. Delete a line that stopped being true.\n\n${kept.map(l => `- ${l}`).join('\n')}\n`)
}

/** Stages the paths and commits them in the worktree with the attribution lines; false when there was nothing to commit or git failed. */
async function commitPaths($: EngineInterface, wt: string, rels: string[], message: string, attribution: string): Promise<boolean> {
  if ((await gitOut($, wt, ['add', '--', ...rels])) === null) return false
  return (await gitOut($, wt, ['commit', '-q', '-m', message, ...(attribution.trim() ? ['-m', attribution.trim()] : []), '--', ...rels])) !== null
}

/** The lead's model use since the last record, added to the ledger's `lead` and reset. */
async function recordLead($: EngineInterface, ledger: Ledger | null): Promise<Record<string, unknown>> {
  const before = (ledger?.['lead'] ?? {}) as { tokens?: number; cached?: number }
  const lead = { tokens: (Number(before.tokens) || 0) + self.lead.tokens, cached: (Number(before.cached) || 0) + self.lead.cached }
  self.lead = { tokens: 0, cached: 0 }
  return lead.tokens || lead.cached ? { lead } : {}
}

/**
 * `begin`: the item is this session's. The claim check, the worktree on the item's branch (made here, reused when
 * there), the base, the status and the ledger in one call; the answer names the worktree to enter and what is next.
 */
async function beginAction($: EngineInterface, found: string, c: Config | null, current: Backlog, id: string, e: ToolInput = { action: 'begin' }): Promise<string> {
  const item = current.items.find(i => i.id === id)!
  const isChild = await isChildSession($)
  const isActive = (ACTIVE_STATUSES as readonly string[]).includes(item.status)
  if (!isActive && item.status !== 'ready' && item.status !== 'blocked') {
    const why = item.status === 'inbox' ? (await judgeAll($, found, current))[id] : undefined
    throw new Refused(`${id} is ${item.status}${why && !why.ready ? `: ${why.reason}` : ''}, not ready`)
  }
  // An item another live session runs is not taken over: two sessions asking for the next item get two items.
  // The live file is read now, under the lock, so a claim made a moment ago by another session is seen.
  if (isActive && self.item !== id && !isChild) {
    await heartbeat($, true)
    const other = (await read($, siblings)).find(x => !x.isStale && x.item === id)
    if (other) throw new Refused(`${id} is run by another session (${other.title}); pick the next item`)
    if (runningOf(await read($, children)).some(ch => ch.item === id)) throw new Refused(`${id} is run by a child session of this one`)
  }
  const mainBranch = c?.mainBranch ?? DEFAULTS.mainBranch
  // What an earlier close had to leave behind (a worktree its session sat in) goes now.
  await sweepMerged($, found, c, current)
  const ledger = await loadLedger($, found, id)
  const branch = typeof ledger?.branch === 'string' && ledger.branch ? ledger.branch : itemBranchOf(c?.branch ?? DEFAULTS.branch, id)
  const rel = typeof ledger?.worktree === 'string' && ledger.worktree ? slashes(ledger.worktree) : `.claude/worktrees/${id}`
  const wt = worktreePath(found, { ...(ledger ?? emptyLedger(id)), worktree: rel })
  const P = placesOf(found, c)
  const gh = isGithub(c)
  // queue: github. The issue as GitHub has it now: the claim of another machine and the spec comment, before any worktree.
  let specMd = ''
  let seen: string[] = []
  if (gh) {
    const fresh = await claimIssue($, found, c, id, ledger !== null, e.force === true)
    specMd = fresh.specMd
    seen = fresh.issue.assignees
  }
  // Off the remote's main when it is known, so the branch starts from what a PR will be compared with.
  await gitOut($, found, ['fetch', '-q', 'origin', mainBranch])
  const from = (await gitOut($, found, ['rev-parse', '--verify', '-q', `origin/${mainBranch}`])) !== null ? `origin/${mainBranch}` : mainBranch
  await ensureWorktree($, found, wt, branch, from)
  if (gh) {
    await ensureExclude($, found)
    await $.fs.write(`${wt}/${P.specRel(id)}`, specMd)
  }
  const base = ledger?.base ?? (await gitOut($, wt, ['merge-base', 'HEAD', from])) ?? (await gitOut($, wt, ['rev-parse', 'HEAD'])) ?? undefined
  const hasTasks = (ledger?.tasks ?? []).length > 0
  const status = item.status === 'ready' || (item.status === 'blocked' && !hasTasks) ? 'planning' : item.status === 'blocked' ? 'building' : item.status
  self.item = id
  const record = () => runTool($, { action: 'ledger', item: id, set: { branch, worktree: rel, ...(base ? { base: base.slice(0, 12) } : {}) } })
  if (!gh) await record()
  if (status !== item.status) await runTool($, { action: 'update', id, set: { status } })
  if (gh) {
    // Two machines that labelled the issue in the same second: of the assignees new since the first read and this
    // user, the login that sorts first keeps the claim. The others let go without touching a label or the status:
    // their worktree, their assignment and their entry in items.json go, and the winner's claim stands.
    if (status !== item.status) {
      const after = await readIssue($, found, id)
      const rivals = after.assignees.filter(a => a !== self.me && !seen.includes(a))
      const winner = [...rivals, self.me].sort()[0]
      if (rivals.length && winner !== self.me) {
        await gitMain($, found, ['worktree', 'remove', '--force', wt])
        const off = await tracker.edit(ghRun($, found), Number(id), { unassign: self.me })
        if (off.ok) await editCache($, found, issues => issues.map(i => (String(i.number) === id ? { ...i, assignees: i.assignees.filter(a => a !== self.me) } : i)))
        const extras = await extrasOrRefuse($, found)
        const { [id]: _gone, ...items } = extras.items
        await writeExtras($, found, { ...extras, items })
        await loadBacklog($, found)
        if (self.item === id) self.item = ''
        throw new Refused(`${id} is being built by @${winner}; pick the next item`)
      }
    }
    // Recorded once the item is in flight, so its entry in items.json keeps the ledger's link.
    await record()
  }
  await heartbeat($, true)
  const spec = gh ? P.specRel(id) : item.spec ?? P.specRel(id)
  const r = ledger?.resume
  const next = hasTasks && r ? `resume: task ${r.task}/${ledger!.tasks.length} · ${r.state}${r.lastVerified ? ` · verified ${r.lastVerified}` : ''}` : `next: read ${spec}, write ${P.planRel(id)}, then plan`
  return `${id} · ${status} · branch ${branch} · base ${(base ?? '?').slice(0, 7)} · ${isChild ? 'this directory is the worktree' : `EnterWorktree { "path": "${wt}" }`} · ${next}`
}

/**
 * `accept`: a verified task is recorded and saved in one call. The open dispatch closed, the task accepted with its
 * commit range, the briefs and reports committed, the branch pushed, the resume block moved to the next task.
 */
async function acceptAction($: EngineInterface, found: string, c: Config | null, id: string, e: ToolInput): Promise<string> {
  const ledger = await loadLedger($, found, id)
  if (!ledger?.tasks.length) throw new Refused(`${id} has no tasks: call plan first`)
  const n = Number(e.task)
  const task = ledger.tasks.find(t => t.n === n)
  if (!task) throw new Refused(`accept needs task: 1 to ${ledger.tasks.length}`)
  const wt = worktreePath(found, ledger)
  const from = ledger.resume?.lastVerified ?? ledger.base ?? ''
  const head = (await gitOut($, wt, ['rev-parse', '--short', 'HEAD'])) ?? ''
  if (!head) throw new Refused(`git could not read HEAD in ${wt}`)
  if (from && (await gitOut($, wt, ['rev-parse', '--short', from])) === head) throw new Refused(`task ${n} has no commit after ${from}: nothing to accept`)
  // The pipeline's own files (a brief rendered again, a report rewritten) are committed below, not the implementer's to commit.
  const P = placesOf(found, c)
  const gh = isGithub(c)
  const dirty = await gitOut($, wt, ['status', '--porcelain', '--untracked-files=no', '--', '.', `:(exclude)${P.recordsDir}`])
  if (dirty) throw new Refused(`uncommitted changes in the worktree, the implementer did not commit:\n${dirty.split('\n').slice(0, 8).join('\n')}`)
  const wasReviewed = (task.dispatches ?? []).some(d => d.role === 'reviewer')
  // The review the config asks for is checked here, so the lead calls accept straight after its own verification.
  const cfg = normalizeConfig(c ?? DEFAULTS).config
  if (!wasReviewed && cfg.taskReview !== 'off' && from) {
    const names = await gitOut($, wt, ['diff', '--name-only', `${from}..${head}`])
    const risky = names === null ? [] : riskyMatches(names.split('\n').map(l => l.trim()).filter(Boolean), cfg.riskyPaths)
    if (cfg.taskReview === 'always' || risky.length) {
      throw new Refused(`review first: ${risky.length ? `task ${n} touches ${risky[0]}` : 'taskReview is always'} · brief { kind: "review", task: ${n}, commits: "${from}..${head}", close: { tokens, minutes, result } }, then accept`)
    }
  }
  const attribution = typeof ledger['attribution'] === 'string' ? (ledger['attribution'] as string) : ''
  // queue: github keeps the records out of the repository: nothing to commit.
  const isRecorded = gh ? false : await commitPaths($, wt, [P.briefDir(id)], `${id}: task ${n} record`, attribution)
  const after = isRecorded ? (await gitOut($, wt, ['rev-parse', '--short', 'HEAD'])) ?? head : head
  const isPushed = ledger.branch ? (await gitOut($, wt, ['push', '-q', '-u', 'origin', ledger.branch])) !== null : false
  const next = ledger.tasks.find(t => t.n !== n && t.status !== 'accepted')?.n
  const close = { ...(typeof e.tokens === 'number' ? { tokens: e.tokens } : {}), ...(typeof e.minutes === 'number' ? { minutes: e.minutes } : {}), result: 'done' }
  const carried = typeof e.carried === 'string' && e.carried.trim() ? [e.carried.trim()] : undefined
  const review = { kind: (wasReviewed ? 'independent' : 'lead-diff') as 'independent' | 'lead-diff', verdict: e.verdict?.trim() || 'approved', ...(carried ? { carried } : {}) }
  await runTool($, { action: 'ledger', item: id, set: { tasks: [{ n, close, status: 'accepted', commits: `${from || 'base'}..${head}`, review }], resume: { task: next ?? n, state: `task ${n} accepted`, lastVerified: after }, ...(await recordLead($, ledger)) } })
  const done = ledger.tasks.filter(t => t.status === 'accepted' || t.n === n).length
  // The issue's status line shows the task counter.
  if (gh) await runTool($, { action: 'update', id, set: { note: `task ${done}/${ledger.tasks.length}` } })
  if (typeof e.fact === 'string' && e.fact.trim()) await addFact($, found, e.fact)
  const line = `${id} · task ${n} accepted · ${done}/${ledger.tasks.length} · ${from ? `${from.slice(0, 7)}..` : ''}${head} · ${isPushed ? 'pushed' : 'not pushed (git push failed: push it yourself)'}`
  // The next Agent call comes with the answer: the next task's implementer, or the final review after the last.
  try {
    const current = (await loadBacklog($, found)).value
    if (current) return `${line} · ${withoutId(id, await briefAction($, found, c, current, id, next ? { action: 'brief', kind: 'implementer', task: next, ...(carried ? { carried: carried[0]! } : {}) } : { action: 'brief', kind: 'final' }))}`
  } catch {}
  return `${line} · next: ${next ? `brief task ${next}` : 'brief final'}`
}

/**
 * A command run to its end with no time limit of the host's (a gate may take longer than the ten minutes one
 * `process.run` gets): the exit code and the last of its output. Null code when it was killed by a signal.
 */
async function runLong($: EngineInterface, argv: string[], cwd: string): Promise<{ code: number | null; out: string }> {
  const stream = $.process.spawn({ argv, cwd })
  let out = ''
  for (;;) {
    const r = await stream.next()
    if (r.done) return { code: r.value?.code ?? null, out }
    out = (out + r.value.text).slice(-20_000)
  }
}

/**
 * `gate`: the tool runs `checks.gate` in the worktree itself and records what happened with the final verdict, so
 * a gate is never green by assumption. Green: the records committed and the branch pushed. Red: the output's tail.
 */
async function gateAction($: EngineInterface, found: string, c: Config | null, id: string, e: ToolInput): Promise<string> {
  const ledger = await loadLedger($, found, id)
  if (!ledger) throw new Refused(`${id} has no ledger`)
  const wt = worktreePath(found, ledger)
  const command = normalizeConfig(c ?? DEFAULTS).config.checks.gate?.trim()
  let gate = 'none configured'
  let output = ''
  if (command) {
    try {
      const r = await runLong($, ['sh', '-c', command], wt)
      gate = r.code === 0 ? 'green' : `red (exit ${r.code ?? 'signal'})`
      if (r.code !== 0) output = tail(r.out.trim(), 20)
    } catch (err) {
      throw new Refused(`the gate could not be run here (${err instanceof Error ? err.message : String(err)}): run \`${command}\` yourself and record it with ledger { final: { verdict, gate } }`)
    }
  }
  const verdict = e.verdict?.trim() || ledger.final?.verdict || 'not reviewed'
  const final = { ...(ledger.final ?? {}), verdict, gate, ...(typeof e.tokens === 'number' ? { tokens: e.tokens } : {}) }
  await runTool($, { action: 'ledger', item: id, set: { final, resume: { task: ledger.resume?.task ?? ledger.tasks.length, state: gate.startsWith('red') ? 'gate red' : 'gate run', ...(ledger.resume?.lastVerified ? { lastVerified: ledger.resume.lastVerified } : {}) }, ...(await recordLead($, ledger)) } })
  if (gate.startsWith('red')) return `${id} · gate ${gate} · \`${command}\`\n${output}`
  const attribution = typeof ledger['attribution'] === 'string' ? (ledger['attribution'] as string) : ''
  if (!isGithub(c)) await commitPaths($, wt, [placesOf(found, c).briefDir(id)], `${id}: final review record`, attribution)
  const isPushed = ledger.branch ? (await gitOut($, wt, ['push', '-q', '-u', 'origin', ledger.branch])) !== null : false
  return `${id} · gate ${gate} · final ${verdict} · ${isPushed ? 'pushed' : 'not pushed (git push failed: push it yourself)'} · next: ${/approved/i.test(verdict) ? 'open the PR' : 'the final review'}`
}

/** One git answer in the main checkout: the exit code and the first line of what it said. */
async function gitMain($: EngineInterface, found: string, args: string[]): Promise<{ ok: boolean; said: string }> {
  try {
    const r = await $.process.run(['git', '-C', found, ...args], { cwd: found, timeoutMs: 120_000 })
    return { ok: r.exitCode === 0, said: (r.stderr || r.stdout).trim().split('\n')[0] ?? '' }
  } catch (err) {
    return { ok: false, said: err instanceof Error ? err.message : String(err) }
  }
}

/** Whether this session's working directory is inside the folder. */
async function isInside($: EngineInterface, dir: string): Promise<boolean> {
  try {
    const cwd = `${slashes(await $.session.cwd())}/`
    return cwd.startsWith(`${slashes(dir)}/`)
  } catch {
    return false
  }
}

/**
 * Removes what `cleanList` names for the merged items it is given, from the main checkout: tracked paths with
 * `git rm`, untracked ones with `git clean`, a worktree with `git worktree remove`, a `branch:` line with
 * `git branch -D`. A worktree this session is inside is left, and named in `kept`.
 */
async function removeCleaned($: EngineInterface, found: string, list: string[]): Promise<{ removed: number; kept: string[]; paths: string[] }> {
  let removed = 0
  const kept: string[] = []
  const paths: string[] = []
  for (const entry of list) {
    if (entry.startsWith('branch:')) {
      // A branch still checked out in a kept worktree cannot go; it goes with the worktree later.
      if ((await gitMain($, found, ['branch', '-D', entry.slice('branch:'.length)])).ok) removed++
      continue
    }
    const rel = entry.replace(/\/+$/, '')
    if (rel.startsWith('.claude/worktrees/')) {
      if (await isInside($, `${found}/${rel}`)) {
        kept.push(rel)
        continue
      }
      if ((await gitMain($, found, ['worktree', 'remove', '--force', rel])).ok) removed++
      continue
    }
    const tracked = await gitMain($, found, ['rm', '-r', '-q', '--ignore-unmatch', '--', rel])
    await gitMain($, found, ['clean', '-fdq', '--', rel])
    if (tracked.ok) {
      removed++
      paths.push(rel)
    }
  }
  return { removed, kept, paths }
}

/** The worktrees and local branches of items already merged, removed when this session is not inside them: what an earlier close had to leave. */
async function sweepMerged($: EngineInterface, found: string, c: Config | null, b: Backlog): Promise<void> {
  try {
    const list = cleanList({ config: c, backlog: b, ...(isGithub(c) ? { queue: 'github' as const } : {}), ...(await cleanInput($, found, b)) }).filter(x => x.startsWith('branch:') || x.startsWith('.claude/worktrees/'))
    // Worktrees first, so their branches are free to delete.
    await removeCleaned($, found, [...list.filter(x => !x.startsWith('branch:')), ...list.filter(x => x.startsWith('branch:'))])
  } catch {}
  if (isGithub(c)) await sweepLeftover($, found)
}

/**
 * queue: github. A closed issue is not in the backlog, so the worktree a close had to leave is kept in items.json:
 * each one this session is not inside is removed, then its branch, and its entry dropped.
 */
async function sweepLeftover($: EngineInterface, found: string): Promise<void> {
  try {
    const extras = await extrasOrRefuse($, found)
    const left = extras.leftover ?? []
    if (!left.length) return
    const kept: Leftover[] = []
    for (const l of left) {
      const dir = worktreePath(found, { ...emptyLedger(l.id), worktree: l.worktree })
      if (await isInside($, dir)) {
        kept.push(l)
        continue
      }
      await gitMain($, found, ['worktree', 'remove', '--force', l.worktree])
      if (l.branch) await gitMain($, found, ['branch', '-D', l.branch])
    }
    const { leftover: _was, ...rest } = extras
    await writeExtras($, found, { ...rest, ...(kept.length ? { leftover: kept } : {}) })
  } catch {}
}

/** queue: github: the worktrees and branches a close had to leave, as `clean` lists them; for one item when `id` is given. */
async function leftoverLines($: EngineInterface, found: string, id: string | undefined): Promise<string[]> {
  const ex = await readExtras($, found)
  return (ex.value?.leftover ?? []).filter(l => id === undefined || l.id === id).flatMap(l => [l.worktree.replace(/\/+$/, ''), ...(l.branch ? [`branch:${l.branch}`] : [])])
}

/**
 * `close`: the whole Close in one call, run by the tool in the main checkout, so it works from a session that
 * sits in the item's worktree and cannot leave it. Refused when the pull request is not on mainBranch yet.
 */
async function closeAction($: EngineInterface, found: string, c: Config | null, current: Backlog, id: string, e: ToolInput): Promise<string> {
  const cfg = normalizeConfig(c ?? DEFAULTS).config
  const item = current.items.find(i => i.id === id)!
  const ledger = await loadLedger($, found, id)
  const branch = (typeof ledger?.branch === 'string' && ledger.branch) || item.branch || itemBranchOf(cfg.branch, id)
  const main = cfg.mainBranch
  const pr = e.pr?.trim() || item.pr || ledger?.pr || undefined
  const gh = isGithub(c)

  if (gh) {
    // queue: github has no record to commit on mainBranch: the main checkout is left as it is, origin/<main> is enough.
    await gitMain($, found, ['fetch', '-q', 'origin', main])
  } else {
    // The main checkout on mainBranch, with the merge in it.
    const on = await gitOut($, found, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (on !== main) {
      const co = await gitMain($, found, ['checkout', main])
      if (!co.ok) throw new Refused(`the main checkout is on ${on ?? 'an unknown branch'} and git checkout ${main} failed: ${co.said}`)
    }
    await gitMain($, found, ['fetch', '-q', 'origin', main])
    const pull = await gitMain($, found, ['merge', '--ff-only', `origin/${main}`])
    if (!pull.ok) throw new Refused(`${main} in the main checkout could not be fast-forwarded to origin/${main}: ${pull.said}`)
  }
  if (item.status !== 'merged' && !e.force) {
    const tip = (await gitOut($, found, ['rev-parse', '--verify', '-q', branch])) ?? (await gitOut($, found, ['rev-parse', '--verify', '-q', `origin/${branch}`]))
    const isIn = tip !== null && (await gitMain($, found, ['merge-base', '--is-ancestor', tip, `origin/${main}`])).ok
    if (!isIn) throw new Refused(`${branch} is not on origin/${main}: the pull request is not merged yet; after a squash merge pass "force": true`)
  }

  const closed = async () => {
    if (ledger) await runTool($, { action: 'ledger', item: id, set: { resume: { task: ledger.resume?.task ?? ledger.tasks.length, state: 'closed', ...(ledger.resume?.lastVerified ? { lastVerified: ledger.resume.lastVerified } : {}) }, ...(await recordLead($, ledger)) } })
  }
  // queue: github: a merged issue leaves the backlog, so its ledger is closed while the item is still there.
  if (gh) await closed()
  // Merged in the backlog (with queue: github the labels off and the issue closed), then what retain lets go.
  if (item.status !== 'merged' || (pr && item.pr !== pr)) await runTool($, { action: 'update', id, set: { status: 'merged', ...(pr ? { pr } : {}) } })
  const after = (await loadBacklog($, found)).value ?? current
  const merged = after.items.some(i => i.id === id) ? after : { ...after, items: [...after.items, { ...item, status: 'merged' as const, ...(pr ? { pr } : {}) }] }
  const list = cleanList({ config: c, backlog: merged, item: id, ...(gh ? { queue: 'github' as const } : {}), ...(await cleanInput($, found, merged)) })
  const { kept, paths: gone } = await removeCleaned($, found, [...list.filter(x => !x.startsWith('branch:')), ...list.filter(x => x.startsWith('branch:'))])
  if (!gh) await closed()
  if (gh) {
    if (kept.length) {
      const extras = await extrasOrRefuse($, found)
      const leftover = [...(extras.leftover ?? []).filter(l => l.id !== id), { id, worktree: kept[0]!, branch }]
      await writeExtras($, found, { ...extras, leftover })
    }
    if (self.item === id) self.item = ''
    const tasks = ledger?.tasks.length ?? 0
    const next = after.items.find(i => i.status === 'ready')
    const left = kept.length ? ` · worktree ${kept[0]} left, this session is in it: the next begin or close removes it` : ''
    return `${id} merged${pr ? ` · PR ${pr}` : ''} · ${tasks} task${tasks === 1 ? '' : 's'} · issue closed${left} · next: ${next ? next.id : 'nothing ready'}`
  }

  // The record on mainBranch.
  const attribution = typeof ledger?.['attribution'] === 'string' ? (ledger['attribution'] as string) : ''
  await gitMain($, found, ['add', '-A', '--', 'docs/pipeline'])
  const commit = await gitMain($, found, ['commit', '-q', '-m', `${id}: close records`, ...(attribution.trim() ? ['-m', attribution.trim()] : []), '--', 'docs/pipeline', ...gone.filter(x => !x.startsWith('docs/pipeline/'))])
  const pushed = cfg.pushMain === false ? 'not pushed (pushMain is off)' : (await gitMain($, found, ['push', '-q', 'origin', main])).ok ? 'pushed' : 'not pushed (git push failed: push it yourself)'
  if (self.item === id) self.item = ''
  const tasks = ledger?.tasks.length ?? 0
  const next = after.items.find(i => i.status === 'ready')
  const left = kept.length ? ` · worktree ${kept[0]} left, this session is in it: the next begin or close removes it` : ''
  return `${id} merged${pr ? ` · PR ${pr}` : ''} · ${tasks} task${tasks === 1 ? '' : 's'} · records ${commit.ok ? 'committed' : 'unchanged'} on ${main} · ${pushed}${left} · next: ${next ? next.id : 'nothing ready'}`
}

/** `plan`: the checked plan becomes the ledger's tasks and resume block, and the item is building. */
async function planAction($: EngineInterface, found: string, c: Config | null, current: Backlog, id: string, e: ToolInput): Promise<string> {
  const ledger = await loadLedger($, found, id)
  const wt = worktreePath(found, ledger)
  const { plan, rel } = await loadPlan($, found, wt, id, ledger)
  const known = new Map((ledger?.tasks ?? []).map(t => [t.n, t]))
  const tasks = plan.tasks.map(t => (known.has(t.n) ? { n: t.n, title: t.title } : { n: t.n, title: t.title, status: 'pending' as const, dispatches: [] }))
  const next = plan.tasks.find(t => known.get(t.n)?.status !== 'accepted')?.n ?? plan.tasks.length
  const lastVerified = ledger?.resume?.lastVerified ?? ledger?.base ?? (await gitOut($, wt, ['rev-parse', '--short', 'HEAD'])) ?? undefined
  const set: LedgerSet = { plan: rel, tasks, resume: { task: next, state: known.size ? ledger?.resume?.state ?? 'planned' : 'planned', ...(lastVerified ? { lastVerified } : {}) } }
  if (typeof e.attribution === 'string') set['attribution'] = e.attribution
  await runTool($, { action: 'ledger', item: id, set })
  const item = current.items.find(i => i.id === id)!
  if (item.status !== 'building') await runTool($, { action: 'update', id, set: { status: 'building' } })
  // The plan is committed here, so the lead spends no turn on it; nothing to commit is fine. queue: github commits no record.
  const attribution = typeof e.attribution === 'string' ? e.attribution : typeof ledger?.['attribution'] === 'string' ? (ledger['attribution'] as string) : ''
  const committed = isGithub(c) ? false : await commitPaths($, wt, [rel], `${id}: plan`, attribution)
  const head = `${id} · building · ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}${committed ? ' · plan committed' : ''}`
  // A fresh plan answers the first Agent call too, so the lead spends no turn asking for it.
  if (!known.size) {
    try {
      const after = (await loadBacklog($, found)).value ?? current
      return `${head} · ${withoutId(id, await briefAction($, found, c, after, id, { action: 'brief', kind: 'implementer', task: next }))}`
    } catch {}
  }
  return `${head} · next: brief task ${next}`
}

/** `brief`: one brief rendered into the worktree, its dispatch opened in the ledger, and the Agent call in one line. */
async function briefAction($: EngineInterface, found: string, c: Config | null, current: Backlog, id: string, e: ToolInput): Promise<string> {
  const kind = e.kind as BriefKind
  if (!BRIEF_KINDS.includes(String(e.kind))) throw new Refused('brief needs kind: implementer, fix, review or final')
  const cfg = normalizeConfig(c ?? DEFAULTS).config
  const ledger = (await loadLedger($, found, id)) ?? emptyLedger(id)
  const wt = worktreePath(found, ledger)
  const { plan } = await loadPlan($, found, wt, id, ledger)
  const n = kind === 'final' ? plan.tasks.length : Number(e.task)
  if (kind !== 'final' && !plan.tasks.some(t => t.n === n)) throw new Refused(`brief needs task: 1 to ${plan.tasks.length}`)
  const P = placesOf(found, c)
  const dir = P.briefDir(id)

  // A review the config does not ask for is answered, not rendered; a re-review (findings given) always runs.
  let risky: string[] = []
  if (kind === 'review') {
    if (!e.commits?.trim()) throw new Refused('a review brief needs commits, as <sha>..<sha>')
    if (!e.findings?.trim()) {
      if (cfg.taskReview === 'off') return `no review: taskReview off · accept task ${n} with review.kind lead-diff`
      const names = await gitOut($, wt, ['diff', '--name-only', e.commits.trim()])
      risky = names === null ? [] : riskyMatches(names.split('\n').map(l => l.trim()).filter(Boolean), cfg.riskyPaths)
      if (cfg.taskReview === 'risky' && names !== null && !risky.length) return `no review: ${e.commits.trim()} touches no risky path · accept task ${n} with review.kind lead-diff`
    }
  }

  // The round is the first whose brief is not on disk yet: fix rounds from 1, a re-review and a second final review from 2.
  let round = 1
  if (kind !== 'implementer') while (round < 50 && (await $.fs.exists(`${wt}/${briefPaths(id, kind, n, round, dir).brief}`))) round++
  if ((kind === 'review' || kind === 'final') && round > 1 && !e.findings?.trim()) throw new Refused(`${briefPaths(id, kind, n, 1, dir).brief} exists: dispatch it again by its path, or pass findings for a scoped re-review`)

  const item = current.items.find(i => i.id === id)!
  const template = await readItemFile($, found, wt, `docs/pipeline/templates/${kind}.md`)
  const head = kind === 'final' ? await gitOut($, wt, ['rev-parse', '--short', 'HEAD']) : null
  let out: ReturnType<typeof renderBrief>
  try {
    out = renderBrief({
      kind, item: id, itemTitle: item.title, task: n, round, plan, config: cfg, ledger,
      root: wt,
      places: { specRel: P.specRel(id), planRel: P.planRel(id), recordsDir: P.recordsDir, briefDir: dir },
      rulesMd: (await readItemFile($, found, wt, 'docs/pipeline/rules.md')) ?? '',
      factsMd: (await readText($, P.facts)) ?? '',
      // queue: github: the spec cache begin wrote in the worktree.
      specMd: (isGithub(c) ? await readText($, `${wt}/${P.specRel(id)}`) : await readItemFile($, found, wt, item.spec ?? P.specRel(id))) ?? '',
      ...(template ? { template } : {}),
      ...(e.findings !== undefined ? { findings: e.findings } : {}),
      ...(e.carried !== undefined ? { carried: e.carried } : {}),
      ...(e.commits !== undefined ? { commits: e.commits } : {}),
      ...(typeof e.attribution === 'string' ? { attribution: e.attribution } : {}),
      ...(head ? { head } : {}),
      risky,
      isEscalated: e.escalate === true,
    })
  } catch (err) {
    throw new Refused(err instanceof Error ? err.message : String(err))
  }
  await $.fs.write(`${wt}/${out.brief}`, out.text)

  // The dispatch before this one (the implementer's before a fix or a review) is closed in the same call.
  if (e.close && typeof e.close === 'object' && kind !== 'final') await runTool($, { action: 'ledger', item: id, set: { tasks: [{ n, close: e.close }] } })
  const total = plan.tasks.length
  const state = kind === 'implementer' ? 'implementer dispatched' : kind === 'fix' ? `fix round ${round} dispatched` : kind === 'review' ? 'review dispatched' : 'final review dispatched'
  const set: LedgerSet = { resume: { task: n, state, ...(ledger.resume?.lastVerified ? { lastVerified: ledger.resume.lastVerified } : {}) } }
  if (kind !== 'final') {
    const dispatch = { role: out.role, model: out.model, effort: out.effort, tokens: 0, minutes: 0, result: '', brief: out.brief, report: out.report, ...(risky[0] ? { risky: risky[0] } : {}) }
    // The same brief asked for twice (plan and accept already answer the next one) opens one dispatch, not two.
    const last = ledger.tasks.find(t => t.n === n)?.dispatches.at(-1)
    const isSame = Boolean(last && last.brief === out.brief && !(last.result ?? '').trim() && !(last.minutes ?? 0))
    set.tasks = [{ n, ...(kind === 'implementer' ? { status: 'running' as const } : kind === 'fix' ? { status: 'fix' as const } : {}), dispatches: isSame ? [] : [dispatch as never] }]
  }
  if (typeof e.attribution === 'string') set['attribution'] = e.attribution
  await runTool($, { action: 'ledger', item: id, set })
  const what = kind === 'final' ? 'final review' : kind === 'fix' ? `task ${n}/${total} · fix round ${round} of ${cfg.limits.fixRounds}` : kind === 'review' ? `task ${n}/${total} · review${round > 1 ? ` ${round}` : ''}` : `task ${n}/${total}`
  return `${id} · ${what} · Agent subagent_type pipeline:${kind === 'review' || kind === 'final' ? 'reviewer' : 'implementer'} model ${out.model} effort ${out.effort} · prompt: Read ${out.brief} and follow it.`
}

/** Whether an update starts an item's run: to planning, or to building from another status. */
const startsRun = (before: Item['status'], after: Item['status']) => (after === 'planning' || after === 'building') && before !== after

/**
 * Queues the session's name after the item it starts (`p12 · CSV export`), once per item in this session, unless
 * `renameSession` is false; a child session is named by its argv from the start and never renames itself. The
 * built-in rename command cannot run from the tool's own hook (it would wait on the turn the hook holds), so the
 * name waits for the turn's end.
 */
async function queueRename($: EngineInterface, c: Config | null, item: Item): Promise<void> {
  if ((c?.renameSession ?? DEFAULTS.renameSession) === false || self.renamed.has(item.id)) return
  if (await isChildSession($)) return
  self.renamed.add(item.id)
  self.pendingRename = sessionName(item)
}

/** The queued rename, at the turn's end; a refusal (no such command, a surface without names) is ignored. */
async function renameNow($: EngineInterface): Promise<void> {
  const name = self.pendingRename
  if (!name) return
  self.pendingRename = ''
  try {
    await $.command.run({ command: 'rename', args: name })
  } catch {}
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
async function startChild($: EngineInterface, found: string, c: Config | null, current: Backlog, id: string, force = false): Promise<string> {
  // The mechanical guard against recursion: a child is started with PIPELINE_CHILD set, and never starts children.
  if (await isChildSession($)) throw new Refused('a child session does not start children')
  const runner = c?.runner ?? DEFAULTS.runner
  if (runner !== 'session') throw new Refused(`runner is ${runner}; set it with /pipeline config runner=session`)
  const item = current.items.find(i => i.id === id)!
  const running = runningOf(await read($, children))
  const own = running.find(ch => ch.item === id)
  if (own) throw new Refused(`${id} already runs in session ${own.id}`)
  if (item.status !== 'ready' && item.status !== 'blocked' && item.status !== 'building') throw new Refused(`${id} is ${item.status}, not ready`)
  // queue: github: the claim begin checks, so the child's begin does not pass on the ledger written here.
  const hasLedger = isGithub(c) && (await loadLedger($, found, id)) !== null
  if (isGithub(c)) await claimIssue($, found, c, id, hasLedger, force)
  // A building item the session runner did not start is being run in a session, this one or another: not taken over.
  // With queue: github and no ledger here, a forced start takes over another machine's run, as begin does.
  const isTakeover = isGithub(c) && force && !hasLedger
  if (item.status === 'building' && !isTakeover && !/session runner/.test(item.note ?? '')) throw new Refused(`${id} is being run in-session (building, note: ${item.note || 'none'}); finish or stop that run, or block the item, before starting it as a child session`)
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
  await writeBacklog($, found, updateItem(current, id, { status: 'building', note }, new Date(at).toISOString()))
  try {
    await runTool($, { action: 'ledger', item: id, set: { branch, worktree: `.claude/worktrees/${id}` } })
  } catch {}
  const child: ChildSession = { id: sessionId, item: id, worktree, branch, status: 'starting', startedAt: at, log: '' }
  await update($, children, prev => [...prev.filter(ch => ch.item !== id), child])
  const argv = childArgv({ prompt: childPrompt(id, { isResume }), permissionMode: mode, sessionId, ...((c?.renameSession ?? DEFAULTS.renameSession) !== false ? { name: sessionName(item) } : {}) })
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
      await writeBacklog($, found, updateItem(fresh, item.id, { status: 'blocked', note: exitNote(after, end) }, new Date(at).toISOString()))
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
    await writeBacklog($, found, updateItem(current, id, { status: 'blocked', note: reason }, new Date(at).toISOString()))
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
    const file = relOf(found, places(found, 'file').ledger(id))
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
    const file = places(found, 'file').specRel(item.id)
    if (!(await $.fs.exists(p.spec(item.id)))) {
      await $.fs.write(p.spec(item.id), specStub(item.id, item.title, item.note, item.source))
      stubs += 1
    }
    next = updateItem(next, item.id, { spec: file }, now)
  }
  const written = await writeBacklog($, found, next)
  const status = await statusNow($, found, normalizeConfig(nextConfig).config, written.backlog, null)

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
  lines.push(commitLine(normalizeConfig(nextConfig).config.mainBranch))
  return lines.join('\n')
}

/** What a project on issues no longer needs, for the lead to remove with git rm once migrate-github has applied. */
const FILE_RECORDS = ['docs/pipeline/backlog.json', 'docs/pipeline/BACKLOG.md', 'docs/pipeline/facts.md', 'docs/pipeline/specs', 'docs/pipeline/plans', 'docs/pipeline/ledgers']

/**
 * `migrate-github`: a file backlog moved onto GitHub issues. Without `apply`, the draft. With it: an issue per open
 * item (its spec as the spec comment, an active one labelled building and assigned), each active item's ledger, plan
 * and briefs copied to the places of queue: github under the issue's number, the facts copied, items.json written,
 * the config set to queue: github and .pipeline/ ignored. It deletes nothing. A failure stops it with what was made;
 * an item whose title already has a labelled open issue is not made again, so a second apply finishes the move.
 */
async function migrateGithub($: EngineInterface, found: string, c: Config | null, loaded: Backlog | null, error: string | null, e: ToolInput): Promise<string> {
  if (isGithub(c)) throw new Refused(`${CONFIG_FILE} already has queue: github; there is no file backlog to move`)
  if (error) throw new Refused(error)
  if (!loaded) throw new Refused(`no ${BACKLOG_FILE} to move`)
  const p = paths(found)
  const F = places(found, 'file')
  const P = places(found, 'github')
  const m = migrationOf(loaded)
  const specPath = (item: Item) => (item.spec ? `${found}/${slashes(item.spec).replace(/^\//, '')}` : p.spec(item.id))
  // An inbox item whose spec still has an open question: asked on its issue, so the issue waits as the item did.
  const questionOf = (item: Item, spec: string | null) => (item.status === 'inbox' && spec !== null && hasOpenQuestion(spec) ? openQuestionOf(spec) : '')
  if (!e.apply) {
    const create = []
    const questions: string[] = []
    for (const item of m.create) {
      const spec = await readText($, specPath(item))
      create.push({ id: item.id, title: item.title, status: item.status, spec: spec !== null ? relOf(found, specPath(item)) : null })
      if (questionOf(item, spec)) questions.push(item.id)
    }
    return JSON.stringify({ create, active: m.active.map(i => i.id), questions, skipped: { merged: m.skipped.merged, parked: m.skipped.parked.map(i => ({ id: i.id, title: i.title })) }, remove: FILE_RECORDS }, null, 2)
  }

  const run = ghRun($, found)
  const who = await tracker.me(run)
  if (!who.ok) throw new Refused(who.error)
  const me = who.value
  self.me = me
  const label = labelOf(c)
  const L = labelsOf(label)
  const labelled = await tracker.ensureLabels(run, [L.queue, L.building, L.blocked, L.needsInfo])
  if (!labelled.ok) throw new Refused(labelled.error)
  const listed = await tracker.list(run, label)
  if (!listed.ok) throw new Refused(listed.error)
  const extras = await extrasOrRefuse($, found)

  const ids = new Map<string, string>()
  const lines: string[] = []
  const stop = (error: string) => new Refused([`migration stopped: ${error}`, ...lines, 'the issues above stay; apply again and it skips them'].join('\n'))
  for (const item of m.create) {
    const spec = await readText($, specPath(item))
    const isActive = (ACTIVE_STATUSES as readonly string[]).includes(item.status)
    const isBlocked = item.status === 'blocked'
    const state = isActive || isBlocked ? item.status : 'ready'
    const detail = item.status === 'review' && item.pr ? `PR ${item.pr}` : isActive || isBlocked ? (item.note ?? '') : ''
    const question = questionOf(item, spec)
    const there = listed.value.find(i => i.title === item.title)
    let n: number
    if (there) {
      n = there.number
    } else {
      const made = await tracker.create(run, { title: item.title, body: issueBodyOf(spec, item.note), labels: [label] })
      if (!made.ok) throw stop(made.error)
      n = made.value
    }
    ids.set(item.id, String(n))
    lines.push(`${item.id} → #${n}`)
    // An issue an earlier apply made gets what that apply did not get to.
    if (spec !== null && !(there && specCommentOf(there, me))) {
      const posted = await tracker.comment(run, n, renderSpecComment(spec, state, detail))
      if (!posted.ok) throw stop(posted.error)
    }
    if (question && !there?.comments.some(cm => cm.body.trimStart().startsWith(QUESTION_MARK) && isTrusted(cm, me))) {
      const asked = await tracker.comment(run, n, `${QUESTION_MARK}\n${question}`)
      if (!asked.ok) throw stop(asked.error)
    }
    const add = isActive ? L.building : isBlocked ? L.blocked : question ? L.needsInfo : ''
    if (add && !there?.labels.includes(add)) {
      const labelledNow = await tracker.edit(run, n, isActive ? { add: [add], assign: me } : { add: [add] })
      if (!labelledNow.ok) throw stop(labelledNow.error)
    }
  }

  // The records of the items in flight, under the issue's number; the branch and the worktree stay what they were.
  const items: Record<string, Partial<Item>> = { ...extras.items }
  for (const item of m.active) {
    const id = ids.get(item.id)!
    const kept: Partial<Item> = { status: item.status }
    for (const k of ['branch', 'pr', 'note', 'size'] as const) if (item[k] !== undefined && item[k] !== null && item[k] !== '') (kept as Record<string, unknown>)[k] = item[k]
    const from = item.ledger ? `${found}/${slashes(item.ledger).replace(/^\//, '')}` : F.ledger(item.id)
    const old = await loadJson<Ledger>($, from, relOf(found, from))
    if (old.error) throw stop(old.error)
    if (old.value && typeof old.value === 'object' && !Array.isArray(old.value)) {
      const briefs = F.briefDir(item.id)
      const moved = JSON.parse(JSON.stringify(old.value).split(`"${briefs}/`).join(`"${P.briefDir(id)}/`)) as Ledger
      const planFrom = typeof old.value.plan === 'string' && old.value.plan ? old.value.plan : typeof item.plan === 'string' && item.plan ? item.plan : null
      const ledger: Ledger = { ...moved, item: id, ...(planFrom ? { plan: P.planRel(id) } : {}) }
      await $.fs.write(P.ledger(id), serialize(ledger))
      kept.ledger = relOf(found, P.ledger(id))
      if (planFrom) kept.plan = P.planRel(id)
      if (typeof ledger.worktree === 'string' && ledger.worktree) {
        const wt = worktreePath(found, ledger)
        const plan = planFrom ? await readItemFile($, found, wt, planFrom) : null
        if (plan !== null) await $.fs.write(`${wt}/${P.planRel(id)}`, plan)
        let dir = `${wt}/${briefs}`
        let names = (await listDir($, dir)).filter(n => !n.endsWith('/'))
        if (!names.length && wt !== found) {
          dir = `${found}/${briefs}`
          names = (await listDir($, dir)).filter(n => !n.endsWith('/'))
        }
        for (const name of names) {
          const text = await readText($, `${dir}/${name}`)
          if (text !== null) await $.fs.write(`${wt}/${P.briefDir(id)}/${name}`, text)
        }
      }
    } else if (!(await $.fs.exists(P.ledger(id)))) {
      // No ledger to carry: a fresh one with the branch and PR, so this machine's begin knows the item as its own.
      const fresh: Ledger = { ...emptyLedger(id), ...(typeof item.branch === 'string' && item.branch ? { branch: item.branch } : {}), ...(typeof item.pr === 'string' && item.pr ? { pr: item.pr } : {}) }
      await $.fs.write(P.ledger(id), serialize(fresh))
      kept.ledger = relOf(found, P.ledger(id))
    } else {
      kept.ledger = relOf(found, P.ledger(id))
    }
    items[id] = kept
  }
  const facts = await readText($, F.facts)
  if (facts !== null) await $.fs.write(P.facts, facts)
  await writeExtras($, found, { ...extras, items })

  // The config on disk with queue: github, every other key as the user left it.
  const onDisk = await loadJson<Record<string, unknown>>($, p.config, CONFIG_FILE)
  if (onDisk.error) throw stop(onDisk.error)
  const nextConfig = { ...(onDisk.value ?? structuredClone(DEFAULTS)), queue: 'github' }
  await $.fs.write(p.config, serialize(nextConfig))
  const normal = normalizeConfig(nextConfig).config
  await update($, config, () => normal)
  await ensureExclude($, found)
  await update($, fileError, () => null)
  await loadBacklog($, found)

  const parked = m.skipped.parked.map(i => i.id)
  return [
    ...lines,
    parked.length ? `parked, not moved (file them by hand when wanted): ${parked.join(', ')}` : 'parked: none',
    `remove with git rm -r --ignore-unmatch and commit with ${CONFIG_FILE} on ${normal.mainBranch}:`,
    ...FILE_RECORDS,
  ].join('\n')
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

/**
 * The active item of this session, with several sessions on one repository each running their own: the item this
 * session last worked on through the tool; else the one whose worktree or branch this session is in; else one a
 * child of this session runs; else the first active item no other live session claims. Null when every active item
 * is another session's.
 */
async function activeItem($: EngineInterface, b: Backlog | null): Promise<Item | null> {
  const actives = (b?.items ?? []).filter(i => (ACTIVE_STATUSES as readonly string[]).includes(i.status))
  if (!actives.length) return null
  const mine = actives.find(i => i.id === self.item)
  if (mine) return mine
  try {
    const name = /\/\.claude\/worktrees\/([^/]+)/.exec(`${slashes(await $.session.cwd())}/`)?.[1]
    const inTree = name ? actives.find(i => i.id === name) : undefined
    if (inTree) return inTree
  } catch {}
  const branch = await branchOf($)
  const onBranch = branch ? actives.find(i => i.branch === branch) : undefined
  if (onBranch) return onBranch
  const kids = new Set((await read($, children)).map(ch => ch.item))
  const ofChild = actives.find(i => kids.has(i.id))
  if (ofChild) return ofChild
  const claimed = new Set((await read($, siblings)).filter(x => !x.isStale && x.item).map(x => x.item))
  return actives.find(i => !claimed.has(i.id)) ?? null
}

/** This session's live entry: the active item, the running agents and every signal of this session. */
async function entryOf($: EngineInterface, previous: LiveEntry | undefined, at: number): Promise<LiveEntry> {
  const nowIso = new Date(at).toISOString()
  if (!self.startedAt) self.startedAt = nowIso
  const active = await activeItem($, await read($, backlog))
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
  await update($, agents, list => list.map((a): AgentRun => (a.status === 'running' ? { ...a, status: 'failed', endedAt: at } : a)))
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
    if (blocked.length) await writeBacklog($, found, next)
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
  isIdleStrip = (options as Record<string, unknown> | undefined)?.idleStrip !== 'hide'
  isCompactTasks = (options as Record<string, unknown> | undefined)?.tasks === 'compact'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Each step on its own, so a refused registration never keeps the files from loading.
    try {
      await $.command.register({ name: 'pipeline', description: DESCRIPTION, argumentHint: 'subcommand' })
    } catch {}
    try {
      // In a project without a pipeline the tool is listed by name only, so it costs no context there.
      let hasPipeline = false
      try {
        hasPipeline = await $.fs.exists(paths(await resolveRoot($)).config)
      } catch {}
      await $.tool.register({ name: 'pipeline', description: TOOL_DESCRIPTION, isDeferred: !hasPipeline, inputSchema: TOOL_SCHEMA })
    } catch {}
    let loaded: { found: string; config: Config | null; backlog: Backlog | null } | null = null
    try {
      const found = await resolveRoot($)
      loaded = { found, ...(await loadAll($, found)) }
    } catch {}
    try {
      self.sessionRoot = slashes(await $.session.root())
    } catch {}
    try {
      await arrive($)
    } catch {}
    // A PR merged by hand since the last session: the person hears it once, in a toast; the status block says it too.
    try {
      if (loaded) for (const m of await checkMerged($, loaded.found, loaded.config, loaded.backlog)) $.ui.toast(`pipeline: ${mergedLine({ ...m, id: idLabel(m.id) })}`)
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
    } else {
      // The lead's own use: re-reading the conversation on every turn is most of an item's cost.
      const u = (result.usage ?? {}) as Record<string, number | undefined>
      self.lead.tokens += (u['input_tokens'] ?? 0) + (u['output_tokens'] ?? 0) + (u['cache_creation_input_tokens'] ?? 0)
      self.lead.cached += u['cache_read_input_tokens'] ?? 0
    }
    return result
  })

  // A subagent's call: a protected path is refused before it runs; otherwise its
  // activity line, and for a shell command whether it failed. The main session's passes.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const call = e as unknown as Call
    // The files only the tool writes: an edit or a shell write by anyone, the lead included, is refused and pointed
    // at the action that does it, so every write is checked, locked and followed by the generated view.
    try {
      if (await read($, config)) {
        const file = EDIT_TOOLS.has(e.tool) ? toolFileOf(pathOf(call) ?? '') : e.tool === 'Bash' ? toolFileWrittenBy(String((call as Record<string, unknown>)['command'] ?? '')) : undefined
        if (file) return { deny: toolFileNote(file) }
      }
    } catch {}
    if (!agentId) return next(e)
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
      // A command that already failed three times in a row, unchanged, is not run a fourth time: the agent is told
      // so directly, which costs the lead no turn.
      if (e.tool === 'Bash') {
        const own = (await read($, agents)).find(a => a.agentId === agentId || a.id === agentId)
        const cmd = normalizeCommand(String((call as Record<string, unknown>)['command'] ?? ''))
        if (own && cmd && own.lastCommands.length >= 3 && own.lastCommands.slice(-3).every(x => x === cmd)) {
          return { deny: `pipeline: this exact command failed three times in a row. Running it again will not change the result. Read the error, change the approach, or stop and answer BLOCKED with what you tried.` }
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
    if (!e.agentId) await renameNow($)
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId) return { result: 'ignored: subagents do not write the pipeline' }
    try {
      const input = e as unknown as ToolInput
      const result = await runTool($, input)
      // The lead's own work on an item makes it this session's: the panel, the band and `get` follow it.
      const worked = ['ledger', 'plan', 'brief', 'begin', 'accept', 'gate'].includes(input.action) ? (typeof input.item === 'string' ? input.item : input.item?.id ?? input.id) : input.action === 'update' && ['planning', 'building'].includes(String((input.set as Partial<Item> | undefined)?.status)) ? input.id : undefined
      if (worked && !(await read($, children)).some(ch => ch.item === worked)) self.item = worked
      return { result }
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
    const strip = band ? '' : await idleText($, e.props.hasSurvey)
    if (!band && !strip) return next(e)
    // The engine's own placeholder ({ type: 'engine' }) is never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const other = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const cols = e.props.bodyColumns || 100
    if (!band) {
      // Nothing active: one slim line with the Open panel button, so the panel is a press away.
      const button = <Button key="band-panel" plain dimColor hotkey="p" label="Open panel" onPress={() => void showPane($)} />
      if (e.surface !== 'terminal' && 'Svg' in ui) {
        const { Svg } = ui
        const width = Math.max(180, Math.min(1600, cols * 8 - 40)) - 24
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" alignItems="flex-start">
              <Svg source={idleStripSvg(strip, width)} alt={strip} width={width} height={BAND_COMPACT_H} />
              {button}
            </Box>
            {other}
          </Box>
        )
      }
      // The row, the gap and the button's `[ Open panel ]` share the columns.
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{idleStripText(strip, Math.max(10, cols - 4 - 'Open panel'.length - 5))}</Text>
            {button}
          </Box>
          {other}
        </Box>
      )
    }
    const panelButton = <Button key="band-panel" plain dimColor hotkey="p" label={(await isPaneOpen($)) ? 'Panel ↗' : 'Panel'} onPress={() => void showPane($)} />
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
            {panelButton}
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
          {panelButton}
        </Box>
        {details}
        {other}
      </Box>
    )
  })

}

// ---------- the commands ----------

type CommandAnswer = { text?: string; context?: readonly string[] }

const ID = /^(?:[a-z][a-z0-9-]*|#?\d+)$/i
/** An id as the tool takes it: `#12` is issue 12. */
const idArg = (id: string) => id.replace(/^#(?=\d+$)/, '')

/** `/pipeline <sub> ...`: text for what the mod answers itself, a prompt for what the model does. */
async function runCommand($: EngineInterface, args: string): Promise<CommandAnswer> {
  const [sub = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  // An id argument may be written as #12: the subcommands that take an id read it without the #.
  const arg = ['status', 'run', 'stop', 'log', 'park', 'unpark'].includes(sub) ? idArg(rest.join(' ')) : rest.join(' ')
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
      if (await isIssueQueue($)) return { text: `refused: ${notWithIssues('move')}` }
      const [id = '', where = '', after = ''] = rest.map(idArg)
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

/** Whether the config on disk says `queue: github`. */
async function isIssueQueue($: EngineInterface): Promise<boolean> {
  try {
    const found = (await read($, root)) || (await resolveRoot($))
    return isGithub((await loadConfig($, found)).value)
  } catch {
    return false
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

/** The first line of the active item's spec, for the running hero; nothing without a spec file. With queue: github, the spec cache in the item's worktree. */
async function specLine($: EngineInterface, found: string, item: Item | null): Promise<string> {
  if (!item) return ''
  const c = await read($, config)
  if (isGithub(c)) {
    const ledger = await loadLedger($, found, item.id)
    const text = ledger?.worktree ? await readText($, `${worktreePath(found, ledger)}/${placesOf(found, c).specRel(item.id)}`) : null
    return text ? specWhat(text) : ''
  }
  if (typeof item.spec !== 'string' || !item.spec) return ''
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
  const d = await gather($, found, c, b, await read($, fileError), true)
  const p = await read($, panel)
  const kids = await read($, children)
  const ledgers: Record<string, Ledger | null> = {}
  for (const k of kids) ledgers[k.item] = await drawnLedger($, found, k.item)
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
    activeLine: await memo($, `what:${d.activeId ?? ''}`, b, 10_000, async () => specLine($, found, await activeItem($, b))),
    limitMs: limitsOf(c).taskMinutes * 60_000,
    fixRounds: limitsOf(c).fixRounds,
    taskReview: c ? normalizeConfig(c).config.taskReview : DEFAULTS.taskReview,
    tasksMode: isCompactTasks ? 'compact' : 'expanded',
    onView: (view: View) => set({ view }),
    onActivity: () => void update($, panel, prev => ({ ...prev, isActivityOpen: !prev.isActivityOpen })),
    onFilter: (filter: QueueFilter) => set({ filter, expanded: null }),
    onSearch: (search: string) => set({ search, expanded: null }),
    onExpand: (expanded: string | null) => set({ expanded }),
    onMore: () => void update($, panel, prev => ({ ...prev, isMoreShown: !prev.isMoreShown })),
    onStop: (item: string) => void pressTool($, { action: 'stop', item }),
    onLog: (item: string) => void pressTool($, { action: 'log', item }),
  })
}

/**
 * The idle strip's line when nothing is active in a project with a pipeline (`pipeline · idle · 28 inbox · next: p2
 * Brand logos`); nothing without a config, during a survey, or with `idleStrip: hide`.
 */
async function idleText($: EngineInterface, hasSurvey: boolean | undefined): Promise<string> {
  try {
    if (!isIdleStrip || hasSurvey || !(await read($, config))) return ''
    return `pipeline · ${idleLine((await read($, backlog))?.items ?? [])}`
  } catch {
    return ''
  }
}

// The item the band keeps showing after it left the active statuses (blocked, or just merged), until the next turn starts.
const bandHold = { item: '', sawIdle: false }

/**
 * The band's data while an item is planning, building or in review, and for a blocked or just-merged item until the
 * model's next turn starts (`isWorking` false once, then true again); nothing when idle.
 */
async function bandNow($: EngineInterface, isWorking: boolean): Promise<Band | null> {
  const b = await read($, backlog)
  let item = await activeItem($, b)
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
  const ledger = await drawnLedger($, found, item.id)
  const at = Math.max(await read($, now), await $.clock.now())
  const agent = (await read($, agents)).find(a => a.status === 'running')
  return bandOf(item, ledger, agent, at)
}
