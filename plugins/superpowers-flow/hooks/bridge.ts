// The slice bridge: a slice that runs in its own Claude Code session writes one JSON file
// under `<git common dir>/superpowers-flow/<run>/`, and the session that started it reads
// the folder to draw each slice in its panel. The common dir is shared by every worktree,
// never committed, and the same whichever branch is checked out. One file per slice, each
// rewritten whole by its own session only, so writers never collide.

import type { EngineInterface } from 'claude-code'

import type { AgentRun, AgentStatus, RoleModels, SliceReport, SliceWorker } from '../types'
import { cleanRoleModels } from './tiers'

// Finished runs untouched this long are removed when a session starts.
export const RUN_MAX_AGE_MS = 3 * 24 * 3600 * 1000
// What one session reads of a run: a run is a handful of slices, each with a few workers.
const MAX_SLICES = 50
export const MAX_CREW = 30

export const slug = (s: string, max = 40): string =>
  s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')

// `2026-10-28-feature-login-login-form`: the day, the branch and the plan, so runs on
// different branches never share a folder.
export const runIdOf = (at: number, branch: string, title: string): string =>
  [new Date(at).toISOString().slice(0, 10), slug(branch, 30) || 'head', slug(title) || 'plan'].join('-')

// A run id or slice name as given by a model: only what is safe as one path segment.
export const segment = (s: unknown): string => (typeof s === 'string' ? slug(s, 60) : '')

// `<git common dir>/superpowers-flow`, or null outside a git repository.
export async function bridgeRoot($: EngineInterface): Promise<string | null> {
  try {
    const out = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const dir = out.stdout.trim()
    return out.exitCode === 0 && dir ? `${dir.replace(/[\\/]+$/, '')}/superpowers-flow` : null
  } catch {
    return null
  }
}

export async function currentBranch($: EngineInterface): Promise<string> {
  try {
    const out = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    return out.exitCode === 0 ? out.stdout.trim() : ''
  } catch {
    return ''
  }
}

const num = (v: unknown, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

const STATUSES: readonly AgentStatus[] = ['running', 'done', 'failed']

const worker = (v: unknown): SliceWorker | null => {
  if (!v || typeof v !== 'object') return null
  const w = v as Record<string, unknown>
  const stepTotal = Math.round(num(w.stepTotal, 100))
  return {
    description: str(w.description, 120),
    type: str(w.type, 80),
    model: str(w.model, 80),
    effort: str(w.effort, 20) || undefined,
    status: STATUSES.includes(w.status as AgentStatus) ? (w.status as AgentStatus) : 'running',
    stepDone: stepTotal ? Math.min(stepTotal, Math.round(num(w.stepDone, 100))) : undefined,
    stepTotal: stepTotal || undefined,
    stepNote: str(w.stepNote, 120) || undefined,
    costUsd: num(w.costUsd, 1e6),
    contextTokens: Math.round(num(w.contextTokens)),
    contextMax: Math.round(num(w.contextMax)),
    startedAt: num(w.startedAt),
    endedAt: typeof w.endedAt === 'number' ? num(w.endedAt) : undefined,
  }
}

// A file another process wrote: taken field by field, anything malformed dropped.
export const parseReport = (text: string, run: string, slice: string): SliceReport | null => {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const total = Math.round(num(raw.total, 200))
  return {
    run,
    slice,
    title: str(raw.title, 120) || slice,
    done: Math.min(total || Infinity, Math.round(num(raw.done, 200))),
    total,
    phase: str(raw.phase, 20),
    isFinished: raw.isFinished === true,
    note: str(raw.note, 120) || undefined,
    model: str(raw.model, 80),
    costUsd: num(raw.costUsd, 1e6),
    contextTokens: Math.round(num(raw.contextTokens)),
    contextMax: Math.round(num(raw.contextMax)),
    crew: Array.isArray(raw.crew) ? raw.crew.slice(-MAX_CREW).map(worker).filter((w): w is SliceWorker => w !== null) : [],
    running: Math.round(num(raw.running, 1000)),
    isStopped: raw.isStopped === true,
    startedAt: num(raw.startedAt),
    updatedAt: num(raw.updatedAt),
    tasks: Array.isArray(raw.tasks) ? raw.tasks.filter((t): t is string => typeof t === 'string').slice(0, 200).map(t => t.slice(0, 120)) : [],
  }
}

// The run's own settings, written by the session that starts the slices and read by each
// slice session, so every slice follows the same profile. Its name can be no slice's: a
// slice name is a slug, and a slug never starts with `_`.
export const RUN_FILE = '_run.json'

export async function writeRunSettings($: EngineInterface, root: string, run: string, options: Record<string, string>, models?: RoleModels): Promise<void> {
  await $.fs.write(`${root}/${run}/${RUN_FILE}`, JSON.stringify({ options, ...(models ? { models } : {}) }))
}

// The models and efforts chosen for the run's roles, as the main session wrote them.
export async function readRunModels($: EngineInterface, root: string, run: string): Promise<RoleModels | undefined> {
  try {
    return cleanRoleModels((JSON.parse(await $.fs.read(`${root}/${run}/${RUN_FILE}`)) as { models?: unknown }).models)
  } catch {
    return undefined
  }
}

// Only the settings `tiers.ts` knows, each a short word: another process wrote the file.
export async function readRunSettings($: EngineInterface, root: string, run: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await $.fs.read(`${root}/${run}/${RUN_FILE}`)) as { options?: Record<string, unknown> }
    return Object.fromEntries(
      Object.entries(raw.options ?? {}).filter((kv): kv is [string, string] => /^[A-Za-z]{1,30}$/.test(kv[0]) && typeof kv[1] === 'string' && /^[a-z]{1,20}$/.test(kv[1])),
    )
  } catch {
    return {}
  }
}

export async function writeReport($: EngineInterface, root: string, report: SliceReport): Promise<void> {
  await $.fs.write(`${root}/${report.run}/${report.slice}.json`, JSON.stringify(report))
}

// Every slice of a run, read again only when its file changed since `seen` noted it;
// null when nothing changed, so the caller writes no state.
export async function readRun(
  $: EngineInterface,
  root: string,
  run: string,
  seen: Map<string, number>,
  prev: SliceReport[],
): Promise<SliceReport[] | null> {
  const entries = await $.fs.list(`${root}/${run}`).catch(() => [])
  const files = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json') && f.name !== RUN_FILE).slice(0, MAX_SLICES)
  let changed = files.length !== prev.length
  const out: SliceReport[] = []
  for (const f of files) {
    const slice = f.name.slice(0, -'.json'.length)
    const old = prev.find(r => r.slice === slice)
    if (old && seen.get(slice) === f.mtimeMs) {
      out.push(old)
      continue
    }
    // A file caught half-written parses as nothing: keep the last good report.
    const report = parseReport(await $.fs.read(`${root}/${run}/${f.name}`).catch(() => ''), run, slice)
    if (report) {
      seen.set(slice, f.mtimeMs)
      changed = true
      out.push(report)
    } else if (old) out.push(old)
  }
  return changed ? out.sort((a, b) => a.startedAt - b.startedAt) : null
}

// Asking a slice session to stop: the main session leaves a file beside its report, which
// the slice session's own tick finds and ends its turn on.
export const stopPath = (root: string, run: string, slice: string): string => `${root}/${run}/${slice}.stop`

export async function askStop($: EngineInterface, root: string, run: string, slice: string): Promise<void> {
  await $.fs.write(stopPath(root, run, slice), 'stop')
}

const LOG_BYTES = 256 * 1024

// One line per event of a slice's stream-json log: what it said, the tools it called and
// how it ended; a line that is no JSON event is shown as it is.
export const logLine = (line: string): string | null => {
  let ev: Record<string, unknown>
  try {
    ev = JSON.parse(line) as Record<string, unknown>
  } catch {
    return line.trim() ? line.trim().slice(0, 300) : null
  }
  if (ev.type === 'result') {
    const cost = typeof ev.total_cost_usd === 'number' ? ` · $${ev.total_cost_usd.toFixed(2)}` : ''
    const time = typeof ev.duration_ms === 'number' ? ` · ${Math.round(ev.duration_ms / 1000)}s` : ''
    return `= ${String(ev.subtype ?? 'result')}${cost}${time}: ${String(ev.result ?? '').replace(/\s+/g, ' ').slice(0, 300)}`
  }
  // A worker's own events (parent_tool_use_id set) stay out: the slice's own story is enough.
  if (ev.type !== 'assistant' || ev.parent_tool_use_id) return null
  const content = (ev.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return null
  const parts = content.flatMap(c => {
    const block = c as { type?: string; text?: string; name?: string; input?: Record<string, unknown> }
    if (block.type === 'text' && block.text?.trim()) return [`› ${block.text.trim().replace(/\s+/g, ' ').slice(0, 300)}`]
    if (block.type === 'tool_use') {
      const input = block.input ?? {}
      const what = input.description ?? input.command ?? input.file_path ?? ''
      return [`· ${block.name ?? 'tool'}${what ? ': ' + String(what).replace(/\s+/g, ' ').slice(0, 120) : ''}`]
    }
    return []
  })
  return parts.length ? parts.join('\n') : null
}

// Where slice sessions' logs go: the repository's git-ignored `.worktrees/`, beside the
// slices' worktrees. Not the run folder: Claude Code guards writes under `.git/`, so a
// launch line's redirect there is refused. A repository whose common dir is not `.git`
// (bare, or set apart) keeps them in the run folder.
export const logDirOf = (root: string, run: string): string => {
  const common = root.replace(/\/superpowers-flow$/, '')
  return /\/\.git$/.test(common) ? `${common.slice(0, -'/.git'.length)}/.worktrees` : `${root}/${run}`
}

// The end of a slice's log as a few readable lines; null when it has none yet.
export async function logTail($: EngineInterface, root: string, run: string, slice: string, lines = 12): Promise<string | null> {
  const path = `${logDirOf(root, run)}/${slice}.log`
  if (!(await $.fs.exists(path).catch(() => false))) return null
  // `tail` keeps a long log's read small; where there is none, the whole file (up to 4 MiB).
  const tail = await $.process.run(['tail', '-c', String(LOG_BYTES), path]).catch(() => null)
  const text = tail?.exitCode === 0 ? tail.stdout : await $.fs.read(path).catch(() => '')
  const out = text
    .split('\n')
    .slice(tail?.exitCode === 0 ? 1 : 0)
    .flatMap(l => logLine(l)?.split('\n') ?? [])
  return out.slice(-lines).join('\n') || null
}

// Removes run folders whose slices all finished and whose files are older than maxAge.
// `$.fs` has no delete, so this asks the host's own tool.
export async function pruneRuns($: EngineInterface, root: string, at: number, maxAge = RUN_MAX_AGE_MS): Promise<string[]> {
  const runs = (await $.fs.list(root).catch(() => [])).filter(d => d.kind === 'dir')
  const removed: string[] = []
  for (const dir of runs) {
    const files = (await $.fs.list(`${root}/${dir.name}`).catch(() => [])).filter(f => f.kind === 'file')
    const reports = files.filter(f => f.name.endsWith('.json') && f.name !== RUN_FILE)
    if (!reports.length || files.some(f => at - f.mtimeMs < maxAge)) continue
    let isDone = true
    for (const f of reports) {
      const r = parseReport(await $.fs.read(`${root}/${dir.name}/${f.name}`).catch(() => ''), dir.name, f.name)
      if (!r?.isFinished) isDone = false
    }
    if (!isDone) continue
    const isWindows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
    const path = `${root}/${dir.name}`
    const argv = isWindows ? ['cmd', '/c', 'rmdir', '/s', '/q', path.replaceAll('/', '\\')] : ['rm', '-rf', path]
    const out = await $.process.run(argv).catch(() => null)
    if (out?.exitCode === 0) removed.push(dir.name)
  }
  return removed
}

// A slice as a panel row: its tasks are its steps, its session's cost and context its own.
export const sliceRow = (r: SliceReport, isStale: boolean): AgentRun => ({
  id: `slice:${r.slice}`,
  type: 'session',
  description: `${r.slice} · ${r.title}`,
  model: r.model,
  status: r.isFinished ? 'done' : isStale || r.isStopped ? 'failed' : 'running',
  startedAt: r.startedAt,
  endedAt: r.isFinished || isStale || r.isStopped ? r.updatedAt : undefined,
  contextTokens: r.contextTokens,
  contextMax: r.contextMax,
  tokens: r.contextTokens,
  costUsd: r.costUsd,
  steps: 0,
  round: 1,
  stepDone: r.done,
  stepTotal: r.total || undefined,
  stepNote: r.note,
})

// A slice session's worker as a panel row, drawn under its slice's row.
export const workerRow = (slice: string, w: SliceWorker, i: number): AgentRun => ({
  id: `slice:${slice}:${i}`,
  type: w.type,
  description: w.description,
  model: w.model,
  effort: w.effort,
  status: w.status,
  startedAt: w.startedAt,
  endedAt: w.endedAt,
  contextTokens: w.contextTokens,
  contextMax: w.contextMax,
  tokens: w.contextTokens,
  costUsd: w.costUsd,
  steps: 0,
  round: 1,
  stepDone: w.stepDone,
  stepTotal: w.stepTotal,
  stepNote: w.stepNote,
})
