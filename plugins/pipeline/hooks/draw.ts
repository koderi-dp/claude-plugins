// The desktop drawings: SVG strings for the panel's header, agent cards, plan rows, compact strip, dotted grid
// and the bar above the prompt. Adapted from savvy-flow (MIT, LICENSE-savvy beside this plugin) through
// superpowers-flow; the crabs stayed there. Pure: strings in, strings out, no engine.

import type { AgentRun, TaskRecord } from '../types'

export const ACCENT = '#8f8cf4'
export const DONE = '#5fbf8f'
export const BLOCKED = '#e8a33c'
export const FAILED = '#D0453F'

export const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

export const xml = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// CJK, fullwidth forms and emoji advance about 1em; at 0.56em a wide title was sized at half its width.
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏！-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// Rough advance of system UI text, in em; good enough to size a text's slot.
const charEm = (ch: string): number => (WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56)

export const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

/** Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut. */
export const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// ---------- money, tokens and time ----------

// USD per million tokens: input, output, cache read, cache write. The first row that matches a model id wins.
export type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]

export const PRICES: [RegExp, Price][] = [
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

export const priceOf = (model: string): Price => PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 8]

/**
 * An estimate of what a run cost, from its token total and its model: the watchdog sums every kind of
 * token into one count, and a subagent's turns are mostly cache reads, so each token is priced between
 * the cache-read and the input rate. The panel marks it with ≈.
 */
export const estimateCost = (model: string, tokens: number): number => {
  const [input, , cacheRead] = priceOf(model)
  return (tokens * (cacheRead * 0.9 + input * 0.1)) / 1e6
}

export const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

export const fmtTokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`)

export const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

export const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

export type Totals = { cost: number; tokens: number; time: number }

/** Cost, tokens and wall time over every run of the session. */
export const totals = (list: AgentRun[], at: number): Totals => {
  const cost = list.reduce((s, a) => s + estimateCost(a.model, a.tokens), 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

export const summaryOf = (t: Totals): string => `≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} tokens · ${fmtTime(t.time)}`

// ---------- the pane's backdrop and frame ----------

export const GRID_STEP = 16
/** A Text or Button row on the desktop is about 20px; the grid errs taller. */
export const LINE_H = 24
/** The engine refuses an Svg taller than 4096px: a long grid is stacked from tiles of at most this height. */
export const GRID_TILE = 4096
/** Finished rows shown, and shown on request; plan rows shown. */
export const ROWS_DONE = 8
export const ROWS_DONE_MORE = 24
export const ROWS_PLANNED = 8

export const gridTiles = (H: number): number[] => Array.from({ length: Math.ceil(H / GRID_TILE) }, (_, i) => Math.min(GRID_TILE, H - i * GRID_TILE))

export const gridSvg = (W: number, H: number): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>.d{fill:#e4e3de}@media (prefers-color-scheme: dark){.d{fill:#2c2c2a}}</style>
<defs><pattern id="g" width="${GRID_STEP}" height="${GRID_STEP}" patternUnits="userSpaceOnUse"><circle class="d" cx="${GRID_STEP / 2}" cy="${GRID_STEP / 2}" r="1"/></pattern></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
</svg>`

const PANE_CSS = `<style>
text{font-family:${FONT}}
.t{fill:#1a1a19}.s{fill:#56554f}.m{fill:#83827c}.k{fill:#e6e5e0}.ln{stroke:#e3e2dd}.tile{fill:#f1f0eb}
@media (prefers-color-scheme: dark){.t{fill:#f2f1ee}.s{fill:#bebdb7}.m{fill:#93928c}.k{fill:#353533}.ln{stroke:#323230}.tile{fill:#292927}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

const svg = (W: number, H: number, body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${body}</svg>`

const startText = (x: number, y: number): string => `x="${x}" y="${y}"`
const endText = (x: number, y: number): string => `x="${x}" y="${y}" text-anchor="end"`

// ---------- status words and pills ----------

const STATUS_COLOR: Record<string, string> = { running: ACCENT, done: '#3B9C5F', failed: FAILED, accepted: '#3B9C5F', fix: BLOCKED, blocked: FAILED }

/** The word a status pill shows: a run's, or a ledger task's. */
export const statusWord = (status: string): string => (status === 'failed' ? 'error' : status === 'pending' ? 'planned' : status)

const statusBadge = (W: number, y: number, status: string): string => {
  const word = statusWord(status)
  const color = STATUS_COLOR[status] ?? ''
  const dot = status === 'running' ? 14 : 0
  const w = Math.round(textWidth(word, 12) + 18 + dot)
  const x = W - w
  const fill = color ? `fill="${color}" fill-opacity="0.14"` : 'class="k"'
  const ink = color ? `fill="${color}"` : 'class="m"'
  return `<rect x="${x}" y="${y}" width="${w}" height="22" rx="11" ${fill}/>
${dot ? `<circle class="live" cx="${x + 13}" cy="${y + 11}" r="4" fill="${color}"/>` : ''}
<text x="${x + 9 + dot}" y="${y + 15.5}" font-size="12" font-weight="600" ${ink}>${xml(word)}</text>`
}

/** A run's mark at the row's left: a disc in its status colour, pulsing while it runs. */
const mark = (x: number, y: number, status: string, dim = false): string =>
  `<circle${status === 'running' ? ' class="live"' : ''} cx="${x + 10}" cy="${y + 10}" r="${dim ? 5 : 7}" fill="${STATUS_COLOR[status] ?? '#888780'}"${dim ? ' fill-opacity="0.5"' : ''}/>`

// ---------- the header ----------

export const headerHeight = (title: string): number => (title ? 96 : 64)

/** The active item's line and three tiles: cost, tokens, time. */
export const headerSvg = (W: number, title: string, t: Totals): string => {
  const gap = 8
  const tw = (W - gap * 2) / 3
  const top = title ? 32 : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="${top}" width="${tw}" height="56" rx="10"/>
<text class="s" ${startText(i * (tw + gap) + 12, top + 21)} font-size="12.5">${k}</text>
<text class="t" ${startText(i * (tw + gap) + 12, top + 44)} font-size="19" font-weight="650" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(
    W,
    headerHeight(title),
    `${title ? `<text class="t" ${startText(0, 19)} font-size="17" font-weight="650">${xml(fitText(title, 17, W))}</text>` : ''}
${tile(0, 'Cost', '≈' + fmtCost(t.cost))}${tile(1, 'Tokens', fmtTokens(t.tokens))}${tile(2, 'Time', fmtTime(t.time))}`,
  )
}

// ---------- rows ----------

export const ROW_H = 96
export const PLAN_H = 62
/** Where a row's text starts, right of its mark. */
const TX = 36

/** A run as a card: its name, model and calls, a bar of its time against the task limit, its activity and stats. */
export const agentSvg = (W: number, a: AgentRun, at: number, limitMs = 0): string => {
  const color = STATUS_COLOR[a.status] ?? ACCENT
  const time = elapsed(a, at)
  const badgeW = textWidth(statusWord(a.status), 12) + 32
  const titleW = W - TX - badgeW - 8
  const meta = [modelName(a.model), `${a.calls} call${a.calls === 1 ? '' : 's'}`]
  const count = a.status === 'running' && limitMs ? `${Math.min(100, Math.round((time / limitMs) * 100))}%` : fmtTime(time)
  const countW = Math.ceil(textWidth(count, 13) * 1.12) + 14
  const barW = Math.max(40, W - TX - countW)
  const progress = a.status === 'running' ? (limitMs ? Math.min(1, time / limitMs) : 0) : 1
  const fillW = Math.max(progress === 0 ? 0 : 8, Math.round(barW * progress))
  const stats = `${fmtTokens(a.tokens)} tokens · ≈${fmtCost(estimateCost(a.model, a.tokens))} · ${fmtTime(time)}`
  const noteW = Math.max(0, W - TX - textWidth(stats, 12.5) - 14)
  const note = a.status === 'failed' ? `error${a.activity ? ` · ${a.activity}` : ''}` : a.activity
  return svg(
    W,
    ROW_H,
    `${mark(0, 8, a.status)}
<text class="t" ${startText(TX, 24)} font-size="15.5" font-weight="650">${xml(fitText(a.name || a.id, 15.5, titleW))}</text>
${statusBadge(W, 8, a.status)}
<text ${startText(TX, 46)} font-size="13"><tspan fill="${color}" font-weight="650">${xml(meta[0]!)}</tspan><tspan class="s">  ${xml(meta.slice(1).join('  ·  '))}</tspan></text>
<rect class="k" x="${TX}" y="57" width="${barW}" height="9" rx="4.5"/><rect x="${TX}" y="57" width="${fillW}" height="9" rx="4.5" fill="${color}"/>
<text class="t" ${endText(W, 66)} font-size="13" font-weight="650" font-variant-numeric="tabular-nums">${xml(count)}</text>
${note && noteW > 40 ? `<text class="t" ${startText(TX, 86)} font-size="12.5">${xml(fitText(note, 12.5, noteW))}</text>` : ''}
<text class="s" ${endText(W, 86)} font-size="12.5" font-variant-numeric="tabular-nums">${stats}</text>
<line class="ln" x1="0" y1="${ROW_H - 0.5}" x2="${W}" y2="${ROW_H - 0.5}"/>`,
  )
}

export type PlanRow = Pick<TaskRecord, 'n' | 'title' | 'status'>

/** A task of the ledger that has not run yet, or waits on a fix. */
export const plannedSvg = (W: number, p: PlanRow): string => {
  const badgeW = textWidth(statusWord(p.status), 12) + 26
  return svg(
    W,
    PLAN_H,
    `${mark(0, 8, p.status, true)}
<text class="s" ${startText(TX, 24)} font-size="14.5" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 14.5, W - TX - badgeW - 8))}</text>
${statusBadge(W, 8, p.status)}
<text class="m" ${startText(TX, 46)} font-size="12.5">task ${p.n}</text>
<line class="ln" x1="0" y1="${PLAN_H - 0.5}" x2="${W}" y2="${PLAN_H - 0.5}"/>`,
  )
}

/** The panel folded: one mark per run and planned task, then the totals. */
export const compactSvg = (W: number, list: AgentRun[], planned: PlanRow[], t: Totals): string => {
  const icons = [
    ...list.filter(a => a.status === 'running').map(a => ({ s: a.status, dim: false })),
    ...list.filter(a => a.status !== 'running').map(a => ({ s: a.status, dim: false })),
    ...planned.map(p => ({ s: p.status, dim: true })),
  ]
  const fit = Math.max(1, Math.floor((W - 150) / 28))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown.map((ic, i) => mark(i * 28, 6, ic.s, ic.dim)).join('')
  const x = shown.length * 28 + (more ? 4 : 0)
  return svg(W, 32, `${body}${more ? `<text class="s" ${startText(x, 21)} font-size="13">+${more}</text>` : ''}
<text class="s" ${endText(W, 21)} font-size="13" font-variant-numeric="tabular-nums">≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`)
}

// ---------- the bar above the prompt ----------

export const BAR_ROW_H = 26
const BAR_H = 18
const CELL = 3

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

export type Bar = { title: string; text: string; done: number; running: number; total: number; isFinished: boolean }

const ratioOf = (b: Bar): number => (b.isFinished ? 1 : b.total ? Math.min(1, b.done / b.total) : 0)

/** The whole row is one SVG: a dot, the title, the dithered bar with its pill, and the percent. */
export const barSvg = (b: Bar, W: number): string => {
  const title = fitText(b.title, 14, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 14) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46)
  const color = b.isFinished ? DONE : ACCENT
  const y0 = (BAR_ROW_H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratioOf(b))
  const runW = b.total ? Math.round((BAR_W * Math.min(b.total, b.done + b.running)) / b.total) : 0
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
  // Handed to a worker, not yet accepted: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }
  const ticks: string[] = []
  for (let i = 1; i < b.total; i++) {
    const x = Math.round((BAR_W * i) / b.total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }
  const pillW = Math.round(20 + b.text.length * 7.2)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const percent = b.total || b.isFinished ? `${Math.round(ratioOf(b) * 100)}%` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${BAR_ROW_H}" viewBox="0 0 ${W} ${BAR_ROW_H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
.t0,.t1,.t2,.t3{animation:tw ${b.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${b.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${b.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${b.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${b.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${BAR_ROW_H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${BAR_ROW_H / 2 + 4.5}" font-family="${FONT}" font-size="14" font-weight="600">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="650" fill="#ffffff">${xml(b.text)}</text>
</g>
<text class="m" x="${W - 6}" y="${BAR_ROW_H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="13.5" font-weight="600" font-variant-numeric="tabular-nums">${percent}</text>
</svg>`
}

/** The bar as text, for the terminal. */
export const barText = (b: Bar, width: number): string => {
  const filled = Math.round(width * ratioOf(b))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}
