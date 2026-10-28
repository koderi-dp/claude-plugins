// Adapted from savvy-progress 1.2.1 by johnnyvizz (MIT; see ../LICENSE-savvy): the same
// bar and panel, with the sp-* tiers of superpowers-flow and step reports from every subagent.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Flow, Panel, Phase, PlannedTask, Role, RoleModels, SliceReport, SliceWorker } from '../types'
import { MAX_CREW, askStop, bridgeRoot, currentBranch, logDirOf, logTail, pruneRuns, readRun, readRunModels, readRunSettings, runIdOf, segment, sliceRow, stopPath, workerRow, writeReport, writeRunSettings } from './bridge'
import { CONFIG_DEFAULTS, PROFILE_NAMES, ROLE_LINE, WORKTREE_LINE, cleanRoleModels, effectiveOf, roleModelsText, fieldOf, handoffWithProfiles, parseConfigArgs, settingsBlock, skillWithSettings, tierSettingsOf, withRunProfile } from './tiers'
import type { TierSettings } from './tiers'
import { pushOrToast, sessionComplete, sessionHooks, sessionRow, sessionStart, sessionStep } from './session'

const flow = atom({ plugin: 'superpowers-flow', key: 'flow' } as const, null)
const agents = atom({ plugin: 'superpowers-flow', key: 'agents' } as const, [])
const panel = atom({ plugin: 'superpowers-flow', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  isMoreShown: false,
  autoOpenedFor: '',
})
const now = atom({ plugin: 'superpowers-flow', key: 'now' } as const, 0)
// Milestone pushes on or off: the `notify` option at start, then `/flow-notify`.
const notify = atom({ plugin: 'superpowers-flow', key: 'notify' } as const, false)
// Slices running in their own sessions, as they last reported through the bridge.
const slices = atom({ plugin: 'superpowers-flow', key: 'slices' } as const, [])
// Set in a slice's own session: the run and slice it reports as.
const bridge = atom({ plugin: 'superpowers-flow', key: 'bridge' } as const, null)

const TOOL = 'mcp__superpowers-flow__progress'
const STEP_TOOL = 'mcp__superpowers-flow__step'
// Added to the end of every subagent's brief: the sp-* workers' system prompt words step
// reporting as a condition ("if the step tool appears among your tools") and they
// skip it even with the tool listed; the same request in the brief is followed.
const STEP_BRIEF = `

Progress reporting: before any other work, call \`${STEP_TOOL}\` with \`total\` (your plan in 3-8 steps) and \`done: 0\`; call it again with \`done\` and a few-word \`note\` as each step finishes. It only draws a progress bar.`
const PANE = 'sp-agents'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const TIERS: readonly string[] = ['fable', 'heavy', 'careful', 'medium', 'light']
// The tools' schemas are advice to the model, not a check: what a call may ask
// the band and the panel to draw is bounded here.
const MAX_TASKS = 200
const MAX_AFTER = 20
const MAX_TITLE = 120
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  finished?: boolean
  tasks?: { title?: string; tier?: string; after?: number[] }[]
  run?: string
  slice?: string
  profile?: string
  models?: unknown
}

// ---------------------------------------------------------------------------
// The words the bar, the panel and the commands show.

const STRINGS = {
  pane: 'Agents',
  cost: 'Cost',
  tokens: 'Tokens',
  time: 'Time',
  collapse: 'Collapse',
  expand: 'Expand',
  running: 'Running',
  finished: 'Finished',
  planned: 'Planned',
  empty: 'No subagents yet.',
  round: 'round',
  failed: 'error',
  after: 'after',
  tokensWord: 'tokens',
  agentsCount: 'agents',
  isRunning: 'running',
  isFinished: 'finished',
  isPlanned: 'planned',
  opened: 'Agents panel opened.',
  closed: 'Agents panel closed.',
  done: 'Done',
  plan: 'Plan',
  design: 'Design',
  tasks: 'Tasks',
  review: 'Review',
  busy: 'running',
  accepted: 'accepted',
  showMore: 'Show more',
  showFewer: 'Show fewer',
  stop: 'Stop',
  log: 'Log',
  stopAsked: 'asked to stop; it ends its turn within a few seconds',
  stoppedNote: 'stopped from the main session',
  noLog: 'no log yet',
  noSlice: 'No such slice session. Slices of this run:',
  noSlices: 'No slice sessions in this run.',
  ctx: 'ctx',
} as const

const blank = (): Flow => ({
  title: 'superpowers',
  total: 0,
  done: 0,
  running: 0,
  phase: 'plan',
  isFinished: false,
  tasks: [],
})

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (input.title !== undefined && clip(input.title.trim(), MAX_TITLE) !== prev.title)

// Only a known tier is kept: the name is later a key into the tier tables.
const tierName = (v: string): string => {
  const t = v.replace(/^sp-/, '').trim().toLowerCase()
  return TIERS.includes(t) ? t : ''
}

const cleanTasks = (tasks: ProgressInput['tasks']): PlannedTask[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .slice(0, MAX_TASKS)
    .map(t => ({
      title: (t.title ?? '').trim(),
      tier: tierName(t.tier ?? ''),
      after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0).slice(0, MAX_AFTER),
    }))

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  const total = Math.min(MAX_TASKS, Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total))))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: clip(input.title?.trim() || base.title, MAX_TITLE),
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    tasks,
    profile: PROFILE_NAMES.includes(input.profile as never) ? input.profile : base.profile,
    models: input.models === undefined ? base.models : cleanRoleModels(input.models),
  }
}

// `fallbackDone`: finished sp-* runs, shown when no plan was ever reported and the
// bar only knows what the safety net counted.
const label = (f: Flow, fallbackDone = 0): string => {
  const s = STRINGS
  if (f.isFinished) return s.done
  if (f.phase === 'plan') return s.plan
  if (f.phase === 'design') return s.design
  const count = f.total ? `${f.done}/${f.total}` : `${fallbackDone} ${s.done.toLowerCase()} · ${f.running} ${s.busy}`
  return `${f.phase === 'review' ? s.review : s.tasks} ${count}`
}

const fallbackDoneOf = (list: AgentRun[]): number => list.filter(a => a.status === 'done' && tierOf(a.type) !== 'other').length

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so title, bar, percent and the crab live in one drawing; only the count and
// the dismiss are Buttons beside it.
const H = 22
const BAR_H = 16
const CRAB_W = 26
// The crab's drawing grid is 30 units wide, props included.
const CRAB_BOX = 30
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

// CJK, fullwidth forms and emoji advance about 1em; at 0.56em a Chinese title was sized at half its width and the bar drew over it.
// 中日韩文字、全角标点和 emoji 约占 1em；按 0.56em 算时中文标题宽度被低估近一半，进度条会压到标题上。
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const rowSvg = (f: Flow, W: number, isWorking: boolean, text: string): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(f.title, 13, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const color = f.isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(f))
  const runW = f.total ? Math.round((BAR_W * Math.min(f.total, f.done + f.running)) / f.total) : 0
  const dots: string[] = []

  // Dithered fill: sparse at the start, dense toward the head.
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  // Handed to workers, not yet accepted: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }

  const ticks: string[] = []
  for (let i = 1; i < f.total; i++) {
    const x = Math.round((BAR_W * i) / f.total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  // No plan reported: there is no share to show.
  const percent = f.total || f.isFinished ? `${Math.round(ratio(f) * 100)}%` : ''
  const crabW = CRAB_BOX * 0.8

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${f.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${f.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${f.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${f.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${f.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(W - CRAB_W + 1, 0, 'other', false, isWorking, 0.8)}
</svg>`
}

const barText = (f: Flow, width: number): string => {
  const filled = Math.round(width * ratio(f))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session, plus the tasks the flow planned.

const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  other: '#888780',
}

// What each sp-* tier runs on, for planned tasks that have no run yet.
const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

const TIER_MODEL: Record<string, [model: string, effort: string]> = {
  fable: ['Fable', 'high'],
  heavy: ['Opus', 'xhigh'],
  careful: ['Opus', 'high'],
  medium: ['Opus', 'medium'],
  light: ['Opus', 'low'],
}

// The user's model and effort for each tier; set in register from the options.
let tierSettings: TierSettings = {}

// "Opus · xhigh"; '' for an unknown tier.
const tierModel = (tier: string): string => {
  const m = TIER_MODEL[tier]
  if (!m) return ''
  const set = tierSettings[tier] ?? {}
  const model = set.model ? set.model.charAt(0).toUpperCase() + set.model.slice(1) : m[0]
  return `${model} · ${set.effort ?? m[1]}`
}

// "Opus 5.5 · low" for a run, or just the model when no effort was seen.
const runModel = (a: AgentRun): string => (a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model))

// USD per million tokens: input, output, cache read, cache write. The first row that
// matches a model id wins, so a release sits above its family.
// The engine reports tokens, not money, so the panel's cost is an estimate. It reports
// one cache-write count with no split by lifetime; writes are priced at the 1-hour
// rate (2x input), which is what Claude Code writes on a subscription.
type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]

const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

// Haiku 5.5 is priced by prompt length: a request whose prompt (input, cache reads and
// cache writes together) is over 100,000 tokens pays these prices instead.
const HAIKU_LONG_PROMPT = 100_000
const HAIKU_LONG: Price = [0.5, 2.5, 0.05, 1]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string, prompt: number): Price => {
  const id = model.toLowerCase()
  if (prompt > HAIKU_LONG_PROMPT && /haiku-5-5/.test(id)) return HAIKU_LONG
  return PRICES.find(([re]) => re.test(id))?.[1] ?? [4, 20, 0.2, 8]
}

// `isRequest` says the usage is one model request, which is what a prompt-length price
// is set by; a turn's sum is priced at the model's ordinary prices.
const costOf = (model: string, u: Usage, isRequest: boolean): number => {
  const prompt = isRequest ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0
  const [i, o, r, w] = priceOf(model, prompt)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

// Haiku 4.5 and the Claude 3 models have a 200K window; the rest, Haiku 5.5 included, 1M.
const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

// `sp-careful`, or `superpowers-flow:sp-careful` when the agents ship in a plugin.
const tierOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  const t = bare.replace(/^sp-/, '').toLowerCase()
  return Object.hasOwn(TIER_COLOR, t) && bare.startsWith('sp-') ? t : 'other'
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

type Planned = PlannedTask & { n: number }

// `elsewhere`: task titles a slice session reported as its own, shown in that slice's row.
const plannedOf = (f: Flow | null, list: AgentRun[], elsewhere: string[] = []): Planned[] => {
  if (!f || f.isFinished) return []
  const started = new Set([...list.map(a => norm(a.description)), ...elsewhere.map(norm)])
  return (f.tasks ?? []).map((t, i) => ({ ...t, n: i + 1 })).filter(t => !started.has(norm(t.title)))
}

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

// The pane's backdrop: a dotted grid as tall as the content laid over it; the
// row SVGs are transparent, so it shows through between their marks.
const GRID_STEP = 16
// A Text or Button row on the desktop is about 20px; the grid errs taller.
const LINE_H = 24
// The engine refuses an Svg taller than 4096px, so a long grid is stacked from
// tiles of at most this height; a multiple of GRID_STEP keeps the dots aligned.
const GRID_TILE = 4096
// Rows the desktop pane draws: every row is an Svg of a few thousand characters, and the
// app stops drawing a pane whose tree grows past a few hundred thousand, as a long run's
// did when the session was opened again. Running rows are always drawn; finished rows
// show the latest few, or more on request, and the rest are counted.
const ROWS_DONE = 8
const ROWS_DONE_MORE = 24
const ROWS_PLANNED = 8
const gridTiles = (H: number) => Array.from({ length: Math.ceil(H / GRID_TILE) }, (_, i) => Math.min(GRID_TILE, H - i * GRID_TILE))
const gridSvg = (W: number, H: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>.d{fill:#d9d8d4}@media (prefers-color-scheme: dark){.d{fill:#3a3a38}}</style>
<defs><pattern id="g" width="${GRID_STEP}" height="${GRID_STEP}" patternUnits="userSpaceOnUse"><circle class="d" cx="${GRID_STEP / 2}" cy="${GRID_STEP / 2}" r="1"/></pattern></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
</svg>`

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-fable.run{animation:float 1s ease-in-out infinite}
.c-fable.run .la,.c-fable.run .lb,.c-fable.run .bd{animation:none}
.c-fable.run .ant{animation:blink 1s steps(1) infinite}
.c-fable.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-heavy.run .it{animation:scan 1s steps(1) infinite}
.c-heavy.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-careful.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-medium.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-medium.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-light.run .la{animation-duration:.25s}.c-light.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-light.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Fable: astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  fable: (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Heavy: detective with a deerstalker; the magnifier sweeps and glints.
  heavy: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Careful: engineer in a hard hat; the wrench turns a bolt.
  careful: (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Medium: chef, the toque traced from DockCrab's Sprites.chefHat; tosses the omelette.
  medium: (f, t) => {
    crabBody(f, -4, 'pan')
    stamp(f, 6, 0, ['........lll.......', '.......lllll......', '.wwwwgwwwwwwgwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwgwwwwwggwwwww', '.wwwwgwwwwwggwwwww', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.'], { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: t, d: '#B45F43' })
    f(22, 8, 7, 2, '#4A4A48', 'pan'); f(26, 10, 1, 1, '#4A4A48', 'pan'); f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  // Light: racer in a helmet; runs at double pace, the checkered flag flutters.
  light: (f, t) => {
    crabBody(f, -4)
    stamp(f, 6, 5, ['....rrrrrrrrrr....', '..rrrrrrwwrrrrrr..', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.kkkkkkkkkkkkkkkkr'], { r: t, w: '#F8F6F1', k: INK })
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: f => crabBody(f),
}

const costumeOf = (type: string): string => (type === 'Explore' ? 'explore' : tierOf(type))

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE): string => {
  // A pixel that continues the previous one in its group (same row, height and color)
  // widens that rect instead of adding one: a costume is drawn row by row, so this
  // keeps the paint order and cuts the markup several times over.
  type Px = { x: number; y: number; w: number; h: number; c: string }
  const groups = new Map<string, Px[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    const list = groups.get(cls) ?? []
    const last = list[list.length - 1]
    if (last && last.y === cy && last.h === h && last.c === c && last.x + last.w === cx) last.w += w
    else list.push({ x: cx, y: cy, w, h, c })
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => crabBody(g))
  draw(f, colorOf(costume))
  const rects = (cls: string) => (groups.get(cls) ?? []).map(r => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.c}"/>`).join('')
  const group = (cls: string) => `<g class="${cls}">${rects(cls)}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${rects('bd')}${props.map(group).join('')}</g>`
  const place = `translate(${x},${y}) scale(${scale})`
  return `<g transform="${place}" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

// Text that starts at x, and text that ends at x.
const startText = (x: number, y: number): string => `x="${x}" y="${y}"`
const endText = (x: number, y: number): string => `x="${x}" y="${y}" text-anchor="end"`

const rowCrab = (x: number, y: number, costume: string, dim = false, isWalking = false): string =>
  crab(x, y, costume, dim, isWalking, CRAB_SCALE)

// Only the crab rules a drawing uses: the rows of a long run each carried every
// costume's rules, and a pane past a few hundred thousand characters stops drawing.
const crabCss = (body: string): string => {
  const used = new Set([...body.matchAll(/class="c-([a-z]+)/g)].map(m => m[1]))
  if (!used.size) return ''
  return CRAB_CSS.split('\n')
    .filter(line => !line.startsWith('.c-') || used.has(/^\.c-([a-z]+)/.exec(line)?.[1]))
    .join('\n')
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${crabCss(body)}${body}</svg>`

// The pane's own title already says "Agents": the header names the flow, if any.
const headerSvg = (W: number, title: string, t: ReturnType<typeof totals>): string => {
  const s = STRINGS
  const gap = 6
  const tw = (W - gap * 2) / 3
  const top = title ? 28 : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="${top}" width="${tw}" height="40" rx="8"/>
<text class="s" ${startText(i * (tw + gap) + 9, top + 16)} font-family="${FONT}" font-size="11">${k}</text>
<text class="t" ${startText(i * (tw + gap) + 9, top + 33)} font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(
    W,
    headerHeight(title),
    `${title ? `<text class="t" ${startText(0, 15)} font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(title, 14, W))}</text>` : ''}
${tile(0, s.cost, '≈' + fmtCost(t.cost))}${tile(1, s.tokens, fmtTokens(t.tokens))}${tile(2, s.time, fmtTime(t.time))}`,
  )
}

const headerHeight = (title: string): number => (title ? 72 : 44)

// The task's own progress when the worker reports steps; a finished run is full.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

const agentSvg = (W: number, a: AgentRun, at: number): string => {
  const s = STRINGS
  const tier = tierOf(a.type)
  const color = colorOf(tier)
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const meta = [runModel(a)]
  if (a.round > 1) meta.push(`${s.round} ${a.round}`)
  if (a.status === 'failed') meta.push(s.failed)
  const barW = textW
  const progress = progressOf(a)
  const stats = `${s.ctx} ${ctx}% · ${fmtTokens(a.contextTokens)}  ≈${fmtCost(a.costUsd)}  ${fmtTime(elapsed(a, at))}`
  const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' · ' + a.stepNote : ''}` : ''
  const stepsW = Math.max(0, barW - textWidth(stats, 11) - 12)
  // Without reported steps the bar falls back to the context, drawn grey.
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  return svg(
    W,
    66,
    `${rowCrab(0, 14, costumeOf(a.type), false, a.status === 'running')}
<text class="t" ${startText(42, 18)} font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>
<text ${startText(42, 34)} font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier === 'other' ? a.type : tier)}</tspan><tspan class="s">  ${xml(meta.join('  ·  '))}</tspan></text>
${steps && stepsW > 30 ? `<text class="t" ${startText(42, 49)} font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(steps, 11, stepsW))}</text>` : ''}
<text class="s" ${endText(42 + barW, 49)} font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<rect class="k" x="${42}" y="55" width="${barW}" height="4" rx="2"/><rect${progress === null ? ' class="m"' : ''} x="${42}" y="55" width="${fillW}" height="4" rx="2"${progress === null ? '' : ` fill="${color}"`}/>
${statusMark(W - 8, 16, a.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

const plannedSvg = (W: number, p: Planned): string => {
  const tier = p.tier in TIER_COLOR ? p.tier : 'other'
  const color = colorOf(tier)
  const textW = W - 42 - 22
  const meta = [tierModel(tier)]
  if (p.after.length) meta.push(`${STRINGS.after} ${p.after.join(', ')}`)
  return svg(
    W,
    46,
    `${rowCrab(0, 6, tier, true)}
<text class="s" ${startText(42, 18)} font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 13, textW))}</text>
<text ${startText(42, 34)} font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier)}</tspan><tspan class="m">  ${xml(meta.filter(Boolean).join('  ·  '))}</tspan></text>
${statusMark(W - 8, 16, 'planned', color)}
<line class="ln" x1="0" y1="45.5" x2="${W}" y2="45.5"/>`,
  )
}

const compactSvg = (W: number, list: AgentRun[], planned: Planned[], t: ReturnType<typeof totals>): string => {
  const icons = [
    ...list.filter(a => a.status === 'running').map(a => ({ k: costumeOf(a.type), c: colorOf(tierOf(a.type)), s: 'running', dim: false })),
    ...list.filter(a => a.status !== 'running').map(a => ({ k: costumeOf(a.type), c: colorOf(tierOf(a.type)), s: a.status, dim: false })),
    ...planned.map(p => ({ k: p.tier in TIER_COLOR ? p.tier : 'other', c: colorOf(p.tier), s: 'planned', dim: true })),
  ]
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    .map((ic, i) => rowCrab(i * 36, 0, ic.k, ic.dim, ic.s === 'running') + (ic.s === 'running' ? `<circle class="live" cx="${i * 36 + 32}" cy="4" r="3" fill="${ic.c}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" ${startText(x, 21)} font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" ${endText(W, 21)} font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', planned: '◷' }

// The panel as text, for `/flow-status`: a phone or browser attached over Remote
// Control sees the conversation only, so this is how the panel reaches it.
const statusText = (f: Flow | null, list: AgentRun[], at: number, elsewhere: string[] = [], crews: Crews = new Map()): string => {
  const s = STRINGS
  const t = totals(list, at)
  const planned = plannedOf(f, list, elsewhere)
  const head = f
    ? `${f.title} · ${label(f, fallbackDoneOf(list))}${f.total || f.isFinished ? ` · ${Math.round(ratio(f) * 100)}%` : ''}`
    : s.empty
  const sums = list.length ? ` · ≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} ${s.tokensWord} · ${fmtTime(t.time)}` : ''
  const line = (a: AgentRun, lead: string): string => {
    const tier = tierOf(a.type)
    const meta = [tier === 'other' ? a.type : tier, runModel(a)]
    if (a.round > 1) meta.push(`${s.round} ${a.round}`)
    if (a.stepTotal) meta.push(`${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''}`)
    meta.push(`≈${fmtCost(a.costUsd)}`, fmtTime(elapsed(a, at)))
    return `${lead}${STATUS_GLYPH[a.status]} ${a.description || a.type}  ·  ${meta.join(' · ')}`
  }
  // A slice session's row, then its own workers beneath it.
  const row = (a: AgentRun): string[] => [line(a, '  '), ...(crews.get(a.id) ?? []).map(w => line(w, '      ↳ '))]
  const running = list.filter(a => a.status === 'running').reverse()
  const finished = list.filter(a => a.status !== 'running').reverse()
  const lines = [head + sums]
  if (running.length) lines.push('', `${s.running} · ${running.length}`, ...running.flatMap(row))
  if (finished.length) lines.push('', `${s.finished} · ${finished.length}`, ...finished.flatMap(row))
  if (planned.length)
    lines.push(
      '',
      `${s.planned} · ${planned.length}`,
      ...planned.map(p => `  ◷ ${p.n}. ${p.title}  ·  ${[p.tier || 'other', tierModel(p.tier), p.after.length ? `${s.after} ${p.after.join(', ')}` : ''].filter(Boolean).join(' · ')}`),
    )
  return '```' + '\n' + lines.join('\n') + '\n' + '```'
}

// Opens the agents pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: STRINGS.pane })
  return true
}

// A slice whose session has written nothing this long, unfinished, is drawn as failed:
// a live session rewrites its file at least every 30 seconds.
const SLICE_STALE_MS = 5 * 60 * 1000

// Each slice session's workers, by its row's id.
type Crews = Map<string, AgentRun[]>

// The panel's rows: the session's own agents, then one row per slice session, whose own
// workers come apart in `crews` (its row's cost already counts theirs).
async function crewOf($: EngineInterface, at: number): Promise<{ list: AgentRun[]; elsewhere: string[]; crews: Crews; reports: SliceReport[] }> {
  const own = await read($, agents)
  const reports: SliceReport[] = await read($, slices)
  return {
    list: [...own, ...reports.map(r => sliceRow(r, !r.isFinished && at - r.updatedAt > SLICE_STALE_MS))],
    elsewhere: reports.flatMap(r => r.tasks),
    crews: new Map(reports.map(r => [`slice:${r.slice}`, r.crew.map((w, i) => workerRow(r.slice, w, i))])),
    reports,
  }
}

// The slice of this run a command or button names; undefined when none matches.
const sliceNamed = (reports: SliceReport[], name: string): SliceReport | undefined => {
  const want = segment(name)
  return reports.find(r => r.slice === want)
}

async function sliceCommand($: EngineInterface, args: string, act: 'stop' | 'log'): Promise<{ text: string }> {
  const { reports } = await crewOf($, await $.clock.now())
  if (!reports.length) return { text: STRINGS.noSlices }
  const r = sliceNamed(reports, args)
  if (!r) return { text: `${STRINGS.noSlice} ${reports.map(x => x.slice).join(', ')}` }
  return { text: act === 'stop' ? await stopSlice($, r) : '```\n' + (await sliceLog($, r)) + '\n```' }
}

async function stopSlice($: EngineInterface, r: SliceReport): Promise<string> {
  const root = await rootOf($)
  if (!root) return `${r.slice}: ${STRINGS.noLog}`
  await askStop($, root, r.run, r.slice)
  return `${r.slice}: ${STRINGS.stopAsked}`
}

async function sliceLog($: EngineInterface, r: SliceReport): Promise<string> {
  const root = await rootOf($)
  const tail = root ? await logTail($, root, r.run, r.slice) : null
  return tail ? `${r.slice} · ${r.title}\n${tail}` : `${r.slice}: ${STRINGS.noLog}`
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  void $.ui.open({ id: PANE, title: STRINGS.pane })
}

// --- the slice bridge (hooks/bridge.ts): the module's own memory of it, which a reload
// starts over; the atoms keep what must survive one.

// `<git common dir>/superpowers-flow`, looked up once; outside a repository null, asked
// again after a minute (the session may have run `git init`).
let rootFound: string | undefined
let rootMissedAt = -Infinity
async function rootOf($: EngineInterface): Promise<string | null> {
  if (rootFound) return rootFound
  const at = await $.clock.now()
  if (at - rootMissedAt < 60_000) return null
  const root = await bridgeRoot($)
  if (root) rootFound = root
  else rootMissedAt = at
  return root
}
// The parent's view: each slice file's mtime when last read.
const seen = new Map<string, number>()
// The slice session's own last write, so an unchanged report is rewritten only as a heartbeat.
let lastReport = ''
let lastWriteAt = 0
const HEARTBEAT_MS = 30_000
// In a slice session: the run's settings as the session that started it wrote them. A
// slice runs its own tasks in place, so it never starts slices of its own.
let sliceOptions: Record<string, string> | null = null
let sliceModels: RoleModels | undefined
// `profile`: one chosen for this run at the plan's handoff.
const optionsFor = (opts: Record<string, unknown>, profile?: string): Record<string, unknown> =>
  sliceOptions ? { ...opts, ...sliceOptions, runner: 'subagent', parallel: 'off' } : withRunProfile(opts, profile)

// In a slice session: the main loop's running turn, which a stop from the main session ends.
let mainTurn: string | undefined
let isStopped = false

// In a slice session: the main session left a stop file. The report says so first, then the
// turn ends, and with it a headless session.
async function obeyStop($: EngineInterface): Promise<void> {
  const b = await read($, bridge)
  const root = b ? await rootOf($) : null
  if (!b || !root || isStopped || !(await $.fs.exists(stopPath(root, b.run, b.slice)).catch(() => false))) return
  isStopped = true
  await syncSlice($, true)
  if (mainTurn) await $.turn.abort({ turnId: mainTurn }).catch(() => undefined)
}

// A session started with the slice environment reports as that slice from its start.
async function joinRun($: EngineInterface): Promise<void> {
  // The environment the slice's launch line sets (the skill's session runner text).
  const run = segment(await $.env.get('SUPERPOWERS_FLOW_RUN').catch(() => undefined))
  const slice = segment(await $.env.get('SUPERPOWERS_FLOW_SLICE').catch(() => undefined))
  if (!run || !slice) return
  const root = await rootOf($)
  sliceOptions = root ? await readRunSettings($, root, run) : {}
  sliceModels = root ? await readRunModels($, root, run) : undefined
  const at = await $.clock.now()
  await update($, bridge, b => (b?.run === run && b.slice === slice ? b : { run, slice, startedAt: at }))
}

// In a slice's own session: rewrites its report when it changed, when `force` asks (a
// `progress` call, so a finish lands before the headless session exits), or as a heartbeat.
async function syncSlice($: EngineInterface, force: boolean): Promise<void> {
  const b = await read($, bridge)
  const root = b ? await rootOf($) : null
  if (!b || !root) return
  const f = await read($, flow)
  const list = await read($, agents)
  const usage = await $.session.usage().catch(() => null)
  const runningNow = list.filter(a => a.status === 'running')
  const busy = runningNow[runningNow.length - 1]
  const report: Omit<SliceReport, 'updatedAt'> = {
    run: b.run,
    slice: b.slice,
    title: f?.title ?? b.slice,
    done: f?.done ?? 0,
    total: f?.total ?? 0,
    phase: f?.phase ?? 'plan',
    isFinished: f?.isFinished ?? false,
    note: isStopped ? STRINGS.stoppedNote : busy ? clip(`${busy.description}${busy.stepNote ? ' · ' + busy.stepNote : ''}`, 120) : undefined,
    model: await $.session.model().catch(() => ''),
    costUsd: usage?.cost?.usd ?? list.reduce((sum, a) => sum + a.costUsd, 0),
    contextTokens: usage?.context.tokens ?? 0,
    contextMax: usage?.context.window ?? 0,
    crew: list.slice(-MAX_CREW).map(
      (a): SliceWorker => ({
        description: a.description,
        type: a.type,
        model: a.model,
        effort: a.effort,
        status: a.status,
        stepDone: a.stepDone,
        stepTotal: a.stepTotal,
        stepNote: a.stepNote,
        costUsd: a.costUsd,
        contextTokens: a.contextTokens,
        contextMax: a.contextMax,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
      }),
    ),
    running: runningNow.length,
    isStopped,
    startedAt: b.startedAt,
    tasks: (f?.tasks ?? []).map(t => t.title),
  }
  const text = JSON.stringify(report)
  const at = await $.clock.now()
  if (!force && text === lastReport && at - lastWriteAt < HEARTBEAT_MS) return
  await writeReport($, root, { ...report, updatedAt: at }).catch(() => undefined)
  lastReport = text
  lastWriteAt = at
}

// In the session that started the slices: reads the run's folder into `slices`.
async function readSlices($: EngineInterface): Promise<void> {
  const f = await read($, flow)
  const prev = await read($, slices)
  // While the flow is open, or a slice it started still runs.
  if (!f?.run || (f.isFinished && !prev.some(r => !r.isFinished))) return
  const root = await rootOf($)
  if (!root) return
  const next = await readRun($, root, f.run, seen, prev)
  if (next) await update($, slices, () => next)
  if ((next ?? (await read($, slices))).some(r => !r.isFinished)) {
    const at = await $.clock.now()
    await update($, now, () => at)
  }
}

export const register: Register = (on, options) => {
  // The settings as this session sees them: the options it started with, then what
  // `/flow-config` changed since.
  const opts: Record<string, unknown> = { ...options }
  tierSettings = tierSettingsOf(opts)
  sessionHooks(on, turnId => {
    mainTurn = turnId
  })
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await joinRun($).catch(() => undefined)
    // Old finished runs' slice folders go; not awaited, so the session starts at once.
    void (async () => {
      const root = await rootOf($)
      if (root) await pruneRuns($, root, await $.clock.now())
    })().catch(() => undefined)
    // The slice bridge: a slice session writes its report, the session that started it reads them.
    $.clock.every(2000, () => {
      void (async () => {
        if (!(await read($, bridge))) return readSlices($)
        await obeyStop($)
        await syncSlice($, false)
      })().catch(() => undefined)
    })
    await sessionStart($)
    await update($, notify, () => opts.notify === 'milestones')
    await $.tool.register({
      name: 'progress',
      description:
        'Report the progress of a superpowers plan run to the progress bar above the prompt and the agents panel. ' +
        'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
        'when switching phase or re-planning (tasks), and once at the end with finished: true. Fields left out keep their previous value. ' +
        'For the main session only: a call from a subagent is ignored (workers report with `step`).',
      // In the main session's tool list, not behind ToolSearch: a controller that has to
      // load it first skips the report instead.
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the flow is closed.' },
          run: { type: 'string', description: 'Only in a slice session: the run id its brief gives.' },
          profile: { type: 'string', enum: [...PROFILE_NAMES], description: 'The profile the user chose for this run at the plan handoff; the result carries its instructions.' },
          models: {
            type: 'object',
            description: 'Models and efforts the user chose for this run at the plan handoff, per role; a role left out is auto. The result says how to mark the briefs.',
            properties: Object.fromEntries(
              ['coder', 'reviewer', 'final'].map(role => [
                role,
                { type: 'object', properties: { model: { type: 'string', enum: ['haiku', 'sonnet', 'opus', 'fable'] }, effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] } } },
              ]),
            ),
          },
          slice: { type: 'string', description: 'Only in a slice session: the slice name its brief gives. With run, this session reports to the session that started it.' },
          tasks: {
            type: 'array',
            description:
              'The planned worker tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so the panel can match runs to tasks.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
                tier: { type: 'string', enum: [...TIERS] },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
              },
              required: ['title', 'tier'],
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For subagents: report progress on your own task to the agents panel. ' +
        'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
      // In every agent's tool list, not behind ToolSearch: workers do not go looking for it.
      isDeferred: false,
    })
    await $.command.register({
      name: 'flow-config',
      description: "List this plugin's settings, or change them: `coderTier=medium mediumModel=sonnet`, or `reset`. The same values as the plugin's Settings tab, saved, and used by this session from now on.",
    })
    await $.command.register({
      name: 'flow-stop',
      description: 'Stop a slice session of this run: `/flow-stop <slice>`. It ends its turn within a few seconds; its branch and commits stay.',
    })
    await $.command.register({
      name: 'flow-log',
      description: "The end of a slice session's log: `/flow-log <slice>`. What it said, the tools it called and how it ended.",
    })
    await $.command.register({
      name: 'flow-notify',
      description: 'Push notifications at milestones (a task accepted, a worker failed, the run finished): `on`, `off`, or no argument to toggle',
    })
    await $.command.register({
      name: 'flow-status',
      description: 'The agents panel as text: the plan, running, finished and planned subagents. Works from a phone or browser attached over Remote Control.',
    })
    await $.command.register({
      name: 'flow-agents',
      description: 'Show or hide the panel of subagents: running, finished and planned, with model, context, cost and time',
    })

    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('skill.prompt', async ($, e, next) => {
    // superpowers:writing-plans asks how to execute the plan: one Subagent-driven option per profile.
    if (/(^|:)writing-plans$/.test(e.skill) && !sliceOptions) {
      const computed = await next(e)
      return { text: handoffWithProfiles(computed.text, opts) }
    }
    if (!/(^|:)superpowers-flow$/.test(e.skill)) return next(e)
    const computed = await next(e)
    const f = await read($, flow)
    return { text: skillWithSettings(computed.text, optionsFor(opts, f?.isFinished ? undefined : f?.profile), tierSettings, tierModel) }
  })

  on('command.run', { command: 'flow-config' }, async ($, e) => {
    const rows = (await $.config.list()).filter(r => fieldOf(r.key) !== null)
    if (!rows.length) return { text: 'No settings found for superpowers-flow in /config: is the plugin enabled?' }
    const arg = (e.args ?? '').trim()
    const { pairs, bad } = arg === 'reset' ? { pairs: Object.entries(CONFIG_DEFAULTS), bad: [] } : parseConfigArgs(arg)
    const notes = bad.map(w => `${w}: write it as key=value`)
    for (const [field, value] of pairs) {
      const row = rows.find(r => fieldOf(r.key) === field)
      if (!row) {
        notes.push(`${field}: no such setting`)
        continue
      }
      if (row.options && !row.options.includes(value)) {
        notes.push(`${field}: takes ${row.options.join(', ')}`)
        continue
      }
      if (row.isLocked) {
        notes.push(`${field}: set by your organization`)
        continue
      }
      const set = await $.config.set({ key: row.key, value })
      if (set.deny !== undefined) notes.push(`${field}: ${set.deny}`)
      else opts[field] = value
    }
    // This session picks the change up at once: the next worker, the next skill load.
    tierSettings = tierSettingsOf(opts)
    await update($, notify, () => opts.notify === 'milestones')
    const width = Math.max(...rows.map(r => (fieldOf(r.key) ?? '').length))
    const list = rows.map(r => {
      const field = fieldOf(r.key) ?? ''
      const value = String(opts[field] ?? r.value)
      return `  ${field.padEnd(width)} = ${value}${r.options ? `   (${r.options.join(', ')})` : ''}`
    })
    const head = pairs.length ? 'superpowers-flow settings, saved:' : 'superpowers-flow settings (change with /flow-config key=value, or reset):'
    return { text: [...notes, '```', head, ...list, '```'].join('\n') }
  })

  on('command.run', { command: 'flow-notify' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    const next = await update($, notify, prev => (arg === 'on' ? true : arg === 'off' ? false : !prev))
    return { text: next ? 'Milestone notifications on.' : 'Milestone notifications off.' }
  })

  on('command.run', { command: 'flow-status' }, async $ => {
    const at = await $.clock.now()
    const { list, elsewhere, crews } = await crewOf($, at)
    return { text: statusText(await read($, flow), list, at, elsewhere, crews) }
  })

  on('command.run', { command: 'flow-agents' }, async ($, e) => {
    // `/flow-agents open` opens the panel, or brings it forward from behind another tab, without toggling it.
    if ((e.args ?? '').trim() === 'open') {
      const at = await $.clock.now()
      await update($, now, () => at)
      await $.ui.open({ id: PANE, title: STRINGS.pane })
      return { text: STRINGS.opened }
    }
    const isOpen = await togglePane($)
    return { text: isOpen ? STRINGS.opened : STRINGS.closed }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    // The flow is the main session's: a call from a worker's loop carries its agentId
    // and changes nothing, or any subagent could rename, finish or reset the flow.
    if (e.agentId) return { result: 'ignored: only the main session reports the flow' }
    const input = e as unknown as ProgressInput
    const prev = await read($, flow)
    const run = segment(input.run)
    const slice = segment(input.slice)
    if (run && slice) {
      // A slice session: it reports through the bridge from now on.
      const at = await $.clock.now()
      await update($, bridge, b => (b?.run === run && b.slice === slice ? b : { run, slice, startedAt: at }))
    }
    const isNew = isNewFlow(prev, input) && input.title !== undefined
    if (isNew) {
      // A new flow starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
      await update($, slices, () => [])
      seen.clear()
    }
    let next = await update($, flow, p => merge(p, input))
    // Only slice sessions report under a run id, so only the session runner makes one.
    const runOptions = optionsFor(opts, next?.profile)
    const effective = effectiveOf(runOptions)
    const isSessionRunner = effective.runner === 'session'
    if (next && !next.run && isSessionRunner && !(await read($, bridge))) {
      const id = runIdOf(await $.clock.now(), await currentBranch($), next.title)
      next = await update($, flow, p => (p ? { ...p, run: id } : p))
      // Every slice session of the run reads these, so all follow this session's profile.
      const root = await rootOf($)
      if (root) await writeRunSettings($, root, id, effective, next?.models).catch(() => undefined)
    }
    if (await read($, bridge)) await syncSlice($, true)
    if (next && input.tasks?.length) await autoOpen($, next.title)
    if (next && (await read($, notify))) {
      // A task accepted, or the run closed: one line to the phone, or a toast.
      if (next.isFinished && !prev?.isFinished) void pushOrToast($, `${next.title}: ${STRINGS.done.toLowerCase()}`, '✓')
      else if (prev && next.done > prev.done && !next.isFinished) void pushOrToast($, `${next.title}: ${next.done}/${next.total || '?'} ${STRINGS.accepted}`, '✓')
    }
    // Slice sessions need the run id and the folder their logs go to; nobody else does.
    const root = next?.run && isSessionRunner ? await rootOf($) : null
    const where = root && next?.run ? ` · run ${next.run} · log folder ${logDirOf(root, next.run)}` : ''
    // A profile chosen at the plan's handoff: its instructions, whenever the skill was loaded.
    const chosen = input.profile && next?.profile === input.profile ? settingsBlock(runOptions, tierSettings, tierModel) : ''
    const howTo = input.profile && next?.profile === input.profile ? `\n\nProfile ${input.profile} for this run.${chosen ? '\n\n' + chosen : ' Superpowers runs as it ships.'}` : ''
    const models = input.models !== undefined && next?.models ? `\n\n${roleModelsText(next.models)}` : ''
    return { result: `ok: ${label(next ?? blank())}${where}${howTo}${models}` }
  })

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    let matched = false
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        matched = true
        const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
        return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || undefined }
      }),
    )
    return { result: matched ? 'ok' : `ignored: no panel row for agent ${agentId}` }
  })

  // Safety net: worker launches move the faint layer even if the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (tierOf(type) === 'other') return next(e)

    await update($, flow, prev => {
      const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
      return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
    })
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const isUnbriefed = !e.prompt.includes(STEP_TOOL)
    // A tier's model from the settings replaces the agent file's; its effort is set per request below.
    // A role the brief names takes the model and effort chosen for it at the plan's handoff.
    const role = e.fork ? undefined : (ROLE_LINE.exec(e.prompt)?.[1] as Role | undefined)
    const chosen = role ? (sliceModels ?? (await read($, flow))?.models)?.[role] : undefined
    const model = e.fork ? undefined : (chosen?.model ?? tierSettings[tierOf(e.subagentType)]?.model)
    // A brief for a slice in its own worktree names it: the worker starts there.
    const tree = e.cwd || e.fork || e.isTeammate ? undefined : WORKTREE_LINE.exec(e.prompt)?.[1]
    const cwd = tree && (await $.fs.stat(tree).catch(() => null))?.kind === 'dir' ? tree : undefined
    const started = await next({
      ...e,
      ...(isUnbriefed ? { prompt: e.prompt + STEP_BRIEF } : {}),
      ...(model ? { model } : {}),
      ...(cwd ? { cwd } : {}),
    })
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    await update($, agents, list => {
      const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round,
        ...(chosen?.effort ? { roleEffort: chosen.effort } : {}),
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    // A slice session's panel row in the main session lists its workers from the start.
    if (await read($, bridge)) await syncSlice($, true).catch(() => undefined)
    if (tierOf(e.subagentType) !== 'other') {
      const f = await read($, flow)
      await autoOpen($, f && !f.isFinished ? f.title : 'superpowers')
    } else if (opts.autoOpen === 'any') {
      await autoOpen($, 'any-agent')
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e0, next) {
    // An sp-* worker's request goes out at the effort the settings give its tier.
    const run = e0.agentId ? (await read($, agents)).find(a => a.agentId === e0.agentId) : undefined
    const effort = run ? (run.roleEffort ?? tierSettings[tierOf(run.type)]?.effort) : undefined
    const e = effort && e0.effort !== undefined ? { ...e0, effort } : e0
    const result = yield* sessionStep($, e, next as never)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    await update($, agents, list =>
      list.map((a): AgentRun =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens:
                a.tokens +
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage, true),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  // `/flow-stop <slice>` and `/flow-log <slice>`: what the slice rows' buttons do, from any device.
  on('command.run', { command: 'flow-stop' }, ($, e) => sliceCommand($, e.args ?? '', 'stop'))
  on('command.run', { command: 'flow-log' }, ($, e) => sliceCommand($, e.args ?? '', 'log'))

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map((a): AgentRun => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens +
                    e.usage.output_tokens +
                    e.usage.cache_read_input_tokens +
                    e.usage.cache_creation_input_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage, false),
                }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
      if (e.reason !== 'answer' && (await read($, notify))) {
        const run = (await read($, agents)).find(a => a.agentId === agentId)
        if (run && tierOf(run.type) !== 'other') void pushOrToast($, `${run.description || run.type}: ${STRINGS.failed}`, '✗')
      }
    }
    const result = await next(e)
    await sessionComplete($, e)
    if (agentId && (await read($, bridge))) await syncSlice($, true).catch(() => undefined)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = STRINGS
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const ticked = await read($, now)
    const { list, elsewhere, crews, reports } = await crewOf($, ticked)
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const at = Math.max(ticked, ...list.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const planned = plannedOf(f, list, elsewhere)
    const t = totals(list, at)
    // A slice session's row carries its Stop (while it runs) and Log buttons; a running one
    // also lists its workers under it.
    const reportOf = (a: AgentRun) => reports.find(r => `slice:${r.slice}` === a.id)
    const actions = (a: AgentRun) => {
      const r = reportOf(a)
      if (!r) return null
      return (
        <Box key={`${a.id}-actions`} flexDirection="row" gap={2}>
          {a.status === 'running' && <Button key={`${a.id}-stop`} label={`${s.stop} ${r.slice}`} plain onPress={async () => $.ui.log(await stopSlice($, r))} />}
          <Button key={`${a.id}-log`} label={`${s.log} ${r.slice}`} plain onPress={async () => $.ui.log(await sliceLog($, r))} />
        </Box>
      )
    }
    const crewOfRow = (a: AgentRun) => (a.status === 'running' ? (crews.get(a.id) ?? []) : [])
    // The pane's title says "Agents"; inside, only the flow's own name.
    const title = f && !f.isFinished ? f.title : ''

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? s.expand : s.collapse}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} ${s.finished} · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const isEmpty = list.length === 0 && planned.length === 0
    const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${s.tokensWord}, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )

      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1}>
            <Svg source={compactSvg(W, list, planned, t)} alt={`${list.length} ${s.agentsCount}, ${summary}`} width={W} height={32} />
            {toggleCompact}
          </Box>
        )
      }
      const doneRows = p.isDoneCollapsed ? [] : finished.slice(0, p.isMoreShown ? ROWS_DONE_MORE : ROWS_DONE)
      const planRows = planned.slice(0, ROWS_PLANNED)
      const doneHidden = p.isDoneCollapsed ? 0 : finished.length - doneRows.length
      const planHidden = planned.length - planRows.length
      // "Show more" while rows are held back below the larger limit; "Show fewer" once it is open.
      const canMore = !p.isDoneCollapsed && !p.isMoreShown && finished.length > ROWS_DONE
      const canFewer = !p.isDoneCollapsed && p.isMoreShown && finished.length > ROWS_DONE
      const lines =
        1 +
        (isEmpty ? 1 : 0) +
        (running.length > 0 ? 1 : 0) +
        (finished.length > 0 ? 1 : 0) +
        (planned.length > 0 ? 1 : 0) +
        (canMore || canFewer ? 1 : 0) +
        (doneHidden > 0 && !canMore ? 1 : 0) +
        (planHidden > 0 ? 1 : 0) +
        [...running, ...doneRows].filter(reportOf).length
      const crewRows = running.reduce((n, a) => n + crewOfRow(a).length, 0)
      const gridH = headerHeight(title) + lines * LINE_H + (running.length + doneRows.length + crewRows) * 66 + planRows.length * 46
      return (
        <Box flexDirection="column">
          {/* The grid sizes the pane; the content is placed over it, as an
              absolute Box paints over the siblings before it. */}
          {gridTiles(gridH).map((tileH, i) => (
            <Svg key={`grid-${i}`} source={gridSvg(W, tileH)} alt="dotted grid" width={W} height={tileH} />
          ))}
          <Box flexDirection="column" position="absolute" top={0} left={0} right={0}>
            <Svg source={headerSvg(W, title, t)} alt={title ? `${title}: ${summary}` : summary} width={W} height={headerHeight(title)} />
            {toggleCompact}
            {isEmpty && <Text dimColor>{s.empty}</Text>}
            {running.length > 0 && section('h-run', `${s.running} · ${running.length}`)}
            {running.flatMap(a => [
              <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isRunning}`} width={W} height={66} />,
              ...crewOfRow(a).map(w => (
                <Box key={w.id} marginLeft={3}>
                  <Svg source={agentSvg(W - 24, w, at)} alt={`${w.description}: ${modelName(w.model)}`} width={W - 24} height={66} />
                </Box>
              )),
              actions(a),
            ])}
            {finished.length > 0 && toggleDone}
            {doneRows.flatMap(a => [
              <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isFinished}`} width={W} height={66} />,
              actions(a),
            ])}
            {canMore && (
              <Button key="more" label={`${s.showMore} · ${doneHidden}`} plain onPress={() => update($, panel, prev => ({ ...prev, isMoreShown: true }))} />
            )}
            {canFewer && <Button key="fewer" label={s.showFewer} plain onPress={() => update($, panel, prev => ({ ...prev, isMoreShown: false }))} />}
            {doneHidden > 0 && !canMore && section('h-done-more', `+${doneHidden} · /flow-status`)}
            {planned.length > 0 && section('h-plan', `${s.planned} · ${planned.length}`)}
            {planRows.map(pl => (
              <Svg key={`plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${s.isPlanned}`} width={W} height={46} />
            ))}
            {planHidden > 0 && section('h-plan-more', `+${planHidden} · /flow-status`)}
          </Box>
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const row = (a: AgentRun, isWorker = false) => {
      const tier = tierOf(a.type)
      const color = colorOf(tier)
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const model = runModel(a)
      const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''} · ` : ''
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1} marginLeft={isWorker ? 3 : 0}>
          <Box flexDirection="row" gap={1}>
            <Text color={color}>{isWorker ? '↳' : '▣'}</Text>
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {tier === 'other' ? a.type : tier} · {model}
            {a.round > 1 ? ` · ${s.round} ${a.round}` : ''}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={color}>{ctxBar(progress * 100, barW)}</Text>}
            <Text dimColor>
              {' '}
              {steps}{s.ctx} {ctx}% · {fmtTokens(a.contextTokens)} ≈{fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}
            </Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {title}
          </Text>
          {toggleCompact}
        </Box>
        <Text dimColor>
          ≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} {s.tokensWord} · {fmtTime(t.time)}
        </Text>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={colorOf(tierOf(a.type))}>
                {STATUS_GLYPH[a.status]}{' '}
              </Text>
            ))}
            {planned.map(pl => (
              <Text key={`plan-${pl.n}`} dimColor>
                ◷{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {isEmpty && <Text dimColor>{s.empty}</Text>}
            {running.length > 0 && <Text dimColor>{s.running} · {running.length}</Text>}
            {running.flatMap(a => [row(a), ...crewOfRow(a).map(w => row(w, true)), actions(a)])}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.flatMap(a => [row(a), actions(a)])}
            {planned.length > 0 && <Text dimColor>{s.planned} · {planned.length}</Text>}
            {planned.map(pl => {
              const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
              return (
                <Box key={`plan-${pl.n}`} flexDirection="column" marginBottom={1}>
                  <Text dimColor wrap="truncate-end">
                    <Text color={colorOf(tier)}>▢</Text> {pl.n}. {pl.title} ◷
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    {tier} · {tierModel(tier)}
                    {pl.after.length ? ` · ${s.after} ${pl.after.join(', ')}` : ''}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const f = await read($, flow)
    // The session row sits under the flow row, so neither can cover the other
    // whatever order the mods load in; other mods' bands go beneath both.
    const session = await sessionRow($, e)
    if (f === null && session === null) return next(e)
    // Claude Code's own placeholder ({ type: 'engine' }) is never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const other = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const below = (
      <Box key="below" flexDirection="column">
        {session}
        {other}
      </Box>
    )
    if (f === null) return below
    const { list, elsewhere } = await crewOf($, await read($, now))
    const crew = list.length + plannedOf(f, list, elsewhere).length
    const isWorking = list.some(a => a.status === 'running')
    const text = label(f, fallbackDoneOf(list))
    const crewButton = (
      <Button key="sp-agents" label={`×${crew}`} plain onPress={() => void togglePane($)} />
    )
    const percent = f.total || f.isFinished ? `${Math.round(ratio(f) * 100)}%` : ''
    const dismiss = (
      <Button
        key="sp-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={() => update($, flow, () => null)}
      />
    )

    // The terminal's element table is completed with an `Svg` that draws nothing: test the surface too.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the count, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={rowSvg(f, width, isWorking, text)} alt={`${f.title}: ${text} ${percent}`} width={width} height={H} />
            {crewButton}
            {dismiss}
          </Box>
          {below}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - titleW - 32))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Box width={titleW} flexShrink={0}>
            <Text color={f.isFinished ? DONE : ACCENT}>● </Text>
            <Text wrap="truncate-end">{f.title}</Text>
          </Box>
          <Text color={f.isFinished ? DONE : ACCENT}>{barText(f, width)}</Text>
          <Text bold>{text}</Text>
          {percent ? <Text dimColor>{percent}</Text> : null}
          <Text color={CLAY}>▣</Text>
          {crewButton}
          {dismiss}
        </Box>
        {below}
      </Box>
    )
  })
}
