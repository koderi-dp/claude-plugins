// What every part of the pipeline shares: the names and limits, the atoms, the per-session values (`self`) and
// the loading of the config and the backlog.
import { atom, read, update } from './state'
import type { Host } from './host'
import type { AgentRun, Backlog, ChildSession, Config, Panel, Sibling, Signal } from '../types'
import type { BgTask } from './background'
import type { Readiness } from './backlog'
import { parseJson, paths } from './files'
import type { MergedPending } from './merged'
import { repoWebUrl } from './migrate'
import { isGithub, loadIssueBacklog } from './github'
import type { Queue } from './github'

/** The plugin options as the host received them: the panel, the band, the idle strip, the task list, the transcripts. */
export const opts = { isAutoOpen: true, isCompactBand: false, isIdleStrip: true, isCompactTasks: false, isTranscripts: false }

export const TOOL = 'mcp__pipeline__pipeline'
export const PANE = 'pipeline'
export const DESCRIPTION = 'The pipeline: `status`, `panel`, `config`, `init`, `add`, `discuss`, `next`, `run`, `migrate`, `stop`, `log`, `move`, `park`, `unpark`, `clean`'
export const USAGE =
  'pipeline: status [id] | panel | config [key=value] | init | add <text> | discuss <text or id> | next | run <id> | run all | migrate | migrate github | stop [id] | log <id> | move <id> top | move <id> after <id> | park <id> | unpark <id> | clean'
export const CONFIG_KEYS = ['mainBranch', 'branch', 'checks', 'riskyPaths', 'protectedPaths', 'models', 'limits', 'runner', 'merge', 'mergeMethod', 'taskReview', 'mode', 'stop', 'afterMerge', 'retain', 'notify', 'superpowers', 'intake', 'pushMain', 'queue', 'queueLabel']
export const CONFIG_FILE = 'docs/pipeline/config.json'
export const BACKLOG_FILE = 'docs/pipeline/backlog.json'
export const BACKLOG_MD_FILE = 'docs/pipeline/BACKLOG.md'
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const TICK_MS = 30_000
export const HEARTBEAT_MS = 2000
/** The last line of init and migrate-apply: the tool's files are versioned, never gitignored, and the record is not on main until this commit. */
export const commitLine = (mainBranch: string) => `commit docs/pipeline/ on ${mainBranch} now: git add docs/pipeline && git commit`

export const WAKE_PROMPT = `pipeline: check the watchdog signals with the pipeline tool: ${TOOL} {"action":"signals"}`
/** The log file of a child, under the main checkout's .git (shared by every worktree, never committed). */
export const childLog = (found: string, id: string) => `${found}/.git/pipeline/${id}.log`
export const LOG_WRITE_MS = 1000
export const ACTIVE_STATUSES = ['planning', 'building', 'review'] as const
export const STATUSES: readonly string[] = ['inbox', 'ready', 'planning', 'building', 'review', 'merged', 'blocked', 'parked']

/** Under 4096 characters: the host gives the model no more of it until the tool is loaded through tool search. */
export const TOOL_DESCRIPTION =
  'The pipeline of this project: backlog, ledgers and the build loop. Main session only; a call from a subagent is ignored. Every write answers one line. The pipeline-run and pipeline-rules skills say when to call what. Actions: ' +
  '`get` { id?, titles?, full? } → JSON: the active item of this session, its resume block, open watchdog signals (each delivered once), children, siblings, counts, the next three items, the config keys a run reads, and `mergedPending` (items whose PR was merged by hand; close them first). `signals` → the open signals only. `status` { id? } → the status block, or one ledger as text. ' +
  'Backlog: `add` { item: { title, size?, needs?, source?, note? }, text? } (text is the spec, written and linked), `update` { id, set }, `move` { id, to: "top" | { after } }, `remove` { id }, `park` { id }, `unpark` { id }. ' +
  'Run: `begin` { item? } claims the item (the first ready one when none is named), makes its worktree and branch and answers the worktree and, under mode direct, the spec. Mode direct: build it your own way, then `ship` { item, message?, attribution?, verdict?, next? } commits what is uncommitted, runs the gate, opens the pull request and, under merge auto, waits for CI, merges and closes; it stops at a red gate, a review to dispatch or red CI and says what to do; with next it begins the next ready item. Its steps, callable alone: `gate` { item, verdict?, tokens? } runs checks.gate itself and pushes when green, red answers the tail; `pr` { item, title?, body? }; `merge` { item, pr? } polls the checks of the PR (an hour at most), merges through gh api and closes, red checks answer their names; `close` { item, pr?, force? } closes an item whose pull request is on mainBranch, from wherever this session is, and removes the worktree and local branch. ' +
  '`adopt` { pr } makes an item of a pull request opened without one: status review with its branch and PR on record, then `merge` or a merge by hand ends it. ' +
  'Mode full (the default): `plan` { item, attribution? } checks docs/pipeline/plans/<id>.md, seeds the tasks and commits the plan, or answers the format or the problems. `brief` { item, kind: implementer | fix | review | final, task?, findings?, carried?, commits?, escalate?, close?: { tokens, minutes, result } } renders the brief, opens the dispatch and answers the Agent call to make; a review the config does not ask for answers `no review`. `accept` { item, task, tokens?, minutes?, verdict?, carried?, fact? } accepts the task, commits the records, pushes and answers the next Agent call. ' +
  '`ledger` { item, set: { tasks?: [{ n, status?, close?, dispatches?, review? }], rulings?: [{ task?, text, why, costIfWrong }], resume?: { task, state, lastVerified? }, final?: { verdict, gate? }, blockers?: [text], pr?, branch?, worktree?, base?, <other key>?: value | null } } merges into the ledger; a wrong shape is refused and nothing is written; null removes a key. ' +
  'Session runner: `start` { item } runs the item in a headless child session, `stop` { item }, `log` { item }. Setup: `init`, `migrate` { refresh? }, `migrate-apply` { config, items, rules, refresh? }, `clean` { item? } lists what config.retain lets go and deletes nothing. A file that does not parse is refused with its line and left alone. ' +
  'With config.queue github the open issues with the queue label are the backlog and an issue number is the id (12); never edit an issue with gh yourself. `add` opens an issue, `spec` { id, text } posts or replaces its spec comment, `question` { id, text } asks on the issue and holds the item, `answer` { id, text } writes what the user answered there and ends the hold, `update` with set { title?, body?, needs?, milestone? } rewrites the text of the issue and keeps its Needs: line unless needs is given (milestone: a title, null: none), `remove` { id, text } closes it as not planned with the reason on it, `adopt` creates the issue and adds Closes #<issue> to the PR, `init` { queue: "github" } sets it up, `move` is refused. `migrate-github` { apply? } drafts, and with apply makes, the move of a file backlog onto issues.'

export const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['get', 'signals', 'status', 'add', 'update', 'move', 'remove', 'park', 'unpark', 'spec', 'question', 'answer', 'ledger', 'begin', 'plan', 'brief', 'accept', 'gate', 'pr', 'adopt', 'ship', 'merge', 'close', 'init', 'clean', 'migrate', 'migrate-apply', 'migrate-github', 'start', 'stop', 'log'] },
    id: { type: 'string', description: 'The item id, as p12. For get: add that item in full.' },
    item: {
      type: ['object', 'string'],
      description: 'For add: the new item. For every other action that takes one: the item id, as p12.',
      properties: {
        title: { type: 'string' },
        size: { type: 'string', enum: ['S', 'M', 'L'] },
        needs: { type: 'array', items: { type: 'string' } },
        source: { type: 'string', description: 'Who asked and when, quoting them.' },
        milestone: { type: 'string', description: 'With queue: github: the title of an open milestone to put the issue in.' },
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
    pr: { type: 'string', description: 'For close: the pull request, as #31, when the item does not carry it yet. For adopt: the pull request to make an item of.' },
    force: { type: 'boolean', description: 'For close: close although the branch tip is not on origin/mainBranch (a squash merge). For begin and start with queue: github: take over here an issue another machine is building.' },
    fact: { type: 'string', description: 'For accept: one line a later implementer must know about working in this repository (a command\'s working spelling, a step that must come first); kept in docs/pipeline/facts.md and given to every brief.' },
    verdict: { type: 'string', description: 'For accept: how the task was approved. For gate: the final review\'s verdict.' },
    kind: { type: 'string', enum: ['implementer', 'fix', 'review', 'final'], description: 'For brief: which brief to render.' },
    task: { type: 'number', description: 'For brief: the task number (not for final).' },
    findings: { type: 'string', description: 'For brief: the findings, verbatim (required for fix; for a re-review or a second final review, its scope).' },
    carried: { type: 'string', description: 'For an implementer brief: minor findings carried from the previous task.' },
    commits: { type: 'string', description: 'For a review brief: the commit range, as <sha>..<sha>.' },
    attribution: { type: 'string', description: 'For plan, brief or ship: the attribution lines this session was given, copied as they are and one per line (the commit trailer and the pull request line), not a sentence about them. The tool ends commits with the git trailers and the pull request with the rest. Kept in the ledger, so once per item is enough.' },
    escalate: { type: 'boolean', description: 'For an implementer or fix brief: dispatch at config.models.escalate.' },
    rules: { type: 'array', description: 'For migrate-apply: the corrected rules, each { group, line, source }.', items: { type: 'object' } },
    text: { type: 'string', description: 'For spec and for add: the spec, with the template\'s headings (add writes and links it). For question: the question to ask on the issue. For answer: what the user answered in the session, in their words. For remove with queue: github: why the issue is not planned.' },
    message: { type: 'string', description: 'For ship: the commit message for what is not committed yet.' },
    next: { type: 'boolean', description: 'For ship: also begin the next ready item and answer it (run all).' },
    title: { type: 'string', description: 'For pr and ship: the pull request title; default the item\'s.' },
    body: { type: 'string', description: 'For pr and ship: the pull request body; default the spec\'s What and Acceptance.' },
    queue: { type: 'string', enum: ['file', 'github'], description: 'For init: github sets the project up with the issues as the queue.' },
    apply: { type: 'boolean', description: 'For migrate-github: move the file backlog onto issues; without it the action answers the draft and writes nothing.' },
  },
  required: ['action'],
}

export const root = atom({ plugin: 'pipeline', key: 'root' } as const, '')
export const config = atom({ plugin: 'pipeline', key: 'config' } as const, null as Config | null)
export const backlog = atom({ plugin: 'pipeline', key: 'backlog' } as const, null as Backlog | null)
export const fileError = atom({ plugin: 'pipeline', key: 'fileError' } as const, null as string | null)
export const agents = atom({ plugin: 'pipeline', key: 'agents' } as const, [] as AgentRun[])
export const signals = atom({ plugin: 'pipeline', key: 'signals' } as const, [] as Signal[])
// The background shell commands still running in this session, as the panel lists them.
export const background = atom({ plugin: 'pipeline', key: 'background' } as const, [] as BgTask[])
// The session runner's children and the other sessions on this repository, as the panel draws them; the runner keeps them.
export const children = atom({ plugin: 'pipeline', key: 'children' } as const, [] as ChildSession[])
export const siblings = atom({ plugin: 'pipeline', key: 'siblings' } as const, [] as Sibling[])
export const panel = atom({ plugin: 'pipeline', key: 'panel' } as const, { view: 'overview', filter: 'inbox', search: '', expanded: null, isMoreShown: false, autoOpenedFor: '', isBandOpen: false, isActivityOpen: false } as Panel)
// The clock the panel draws against: the ticker moves it, so minutes and the merged week stay current.
export const now = atom({ plugin: 'pipeline', key: 'now' } as const, 0)

export const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// What this module instance knows between hooks: the live file's whereabouts,
// this session's entry, the heartbeat throttle, the pending wake-up and the ticker.
const newSelf = () => ({
  hasRepo: false,
  sessionRoot: '',
  /** Why the tool could not be given to the model in this session; empty when it was. */
  toolError: '',
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
  // What the pipeline last called this session, for the saved transcript's record.
  sessionName: '',
  // The saved transcript of this session: its folder, fixed at the first save, and what was copied already.
  log: { id: '', folder: '', startedAt: 0, version: '', hasFailed: false, sizes: new Map<string, number>(), earlier: { name: '', items: [] as string[] } },
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
})
export type Self = ReturnType<typeof newSelf>

let selfNow: () => Self = (() => {
  const one = newSelf()
  return () => one
})()

/**
 * One program, several sessions (a host that serves them all from one process): the host says which session's
 * values are meant at any moment, and is given the maker of a fresh set. Without this there is one set, the session's.
 */
export function scopeSelf(resolve: (make: () => Self) => Self): void {
  selfNow = () => resolve(newSelf)
}

export const self: Self = new Proxy({} as Self, {
  get: (_target, key) => selfNow()[key as keyof Self],
  set: (_target, key, value) => {
    ;(selfNow() as Record<string, unknown>)[key as string] = value
    return true
  },
})

/** The web URL of the repository's origin, for PR numbers the old queue names; nothing without a remote. */
export async function repoUrl(h: Host): Promise<string | undefined> {
  try {
    return repoWebUrl((await h.session.repo())?.remote)
  } catch {
    return undefined
  }
}

/** The main checkout's root, even from a worktree; the session's root without a repository. */
export async function resolveRoot(h: Host): Promise<string> {
  let repoRoot: string | undefined
  try {
    repoRoot = (await h.session.repo())?.root
  } catch {}
  self.hasRepo = Boolean(repoRoot)
  const found = slashes(repoRoot ?? (await h.session.root()))
  await update(h, root, () => found)
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

export type Loaded<T> = { value: T | null; error: string | null }

/** Reads a JSON file: missing gives null and no error, bad JSON gives the error with its line. */
export async function loadJson<T>(h: Host, path: string, file: string): Promise<Loaded<T>> {
  if (!(await h.fs.exists(path))) return { value: null, error: null }
  const text = await h.fs.read(path)
  const parsed = parseJson<T>(typeof text === 'string' ? text : '', file)
  return parsed.ok ? { value: parsed.value, error: null } : { value: null, error: parsed.error }
}

/** Reads the config file into its atoms. */
export async function loadConfig(h: Host, found: string): Promise<Loaded<Config>> {
  const loaded = await loadJson<Config>(h, paths(found).config, CONFIG_FILE)
  await update(h, config, () => loaded.value)
  return loaded
}

/** Reads the backlog file into its atom; with queue: github, the issues through their cache. Never throws in that mode. */
export async function loadBacklog(h: Host, found: string): Promise<Loaded<Backlog>> {
  const c = await read(h, config)
  if (isGithub(c)) return loadIssueBacklog(h, found, c)
  const loaded = await loadJson<Backlog>(h, paths(found).backlog, BACKLOG_FILE)
  await update(h, backlog, () => loaded.value)
  return loaded
}

/** Reads both files; `fileError` is the first error, the config's before the backlog's. */
export async function loadAll(h: Host, found: string): Promise<{ config: Config | null; backlog: Backlog | null; error: string | null }> {
  const c = await loadConfig(h, found)
  const b = await loadBacklog(h, found)
  const error = c.error ?? b.error
  await update(h, fileError, () => error)
  return { config: c.value, backlog: b.value, error }
}
