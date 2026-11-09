// The desktop drawings: SVG strings for the dashboard's hero, metric tiles, agent card and the bar above
// the prompt. The text sizing and the pricing came from savvy-flow (MIT, LICENSE-savvy beside this plugin)
// through superpowers-flow. Pure: strings in, strings out, no engine.

import type { AgentRun } from '../types'
import type { Band, Step, TagKind } from './status'
import { SEGMENT_COLORS } from './status'

// The mockup's colours: purple for what runs, green for what merged, amber for what is blocked or has no spec.
export const ACCENT = '#a59aff'
export const DONE = '#72d1a6'
export const BLOCKED = '#f1bd7e'
export const MUTED = '#7f828f'
export const FAILED = '#f68b91'

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

// ---------- the frame ----------

const PANE_CSS = `<style>
text{font-family:${FONT}}
.t{fill:#1a1a19}.s{fill:#56554f}.m{fill:#83827c}.k{fill:#e6e5e0}.tile{fill:#f1f0eb;stroke:#e3e2dd}.hero{fill:#efedf7;stroke:#d9d4ee}.card{fill:#f1f0eb;stroke:#e3e2dd}.hair{fill:#e3e2dd}.chip{fill:#ece9f7;stroke:#d9d4ee}
@media (prefers-color-scheme: dark){.t{fill:#f3f3f6}.s{fill:#bbbcc6}.m{fill:#7f828f}.k{fill:#3d394a}.tile{fill:#1c1d23;stroke:#2b2d36}.hero{fill:#231f33;stroke:#353045}.card{fill:#211e31;stroke:#443b67}.hair{fill:#292b33}.chip{fill:#282434;stroke:#39334f}}
.live{animation:p 2.2s ease-in-out infinite}@keyframes p{50%{opacity:.45}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

const svg = (W: number, H: number, body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${body}</svg>`

const startText = (x: number, y: number): string => `x="${x}" y="${y}"`
const endText = (x: number, y: number): string => `x="${x}" y="${y}" text-anchor="end"`

/** Breaks a sentence into lines of at most `maxW` pixels, at most `max` of them, the last cut with an ellipsis. */
export const wrapText = (s: string, size: number, maxW: number, max = 3): string[] => {
  const lines: string[] = []
  let current = ''
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word
    if (textWidth(next, size) <= maxW || !current) current = next
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  if (lines.length <= max) return lines.map(l => fitText(l, size, maxW))
  const kept = lines.slice(0, max)
  kept[max - 1] = fitText(lines.slice(max - 1).join(' '), size, maxW)
  return kept
}

/** A disc in a colour, pulsing when live. */
const dot = (x: number, y: number, color: string, isLive: boolean, r = 3.5): string => `<circle${isLive ? ' class="live"' : ''} cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`

// ---------- the hero ----------

export type Drawing = { source: string; height: number }

export type Hero = {
  kind: 'idle' | 'running' | 'history'
  /** The state line: `PIPELINE IDLE`, `BUILDING · P14`. */
  state: string
  headline: string
  /** The sentence under the headline; wrapped. */
  line: string
  /** Idle: the chip at the foot and the hint beside it. */
  chip?: string
  hint?: string
  /** Running: accepted over total and the steps. */
  progress?: { done: number; total: number }
  steps?: Step[]
}

const HERO_PAD = 18
const STEP_COLOR: Record<Step['state'], string> = { done: DONE, current: ACCENT, pending: '' }
const STEP_MARK: Record<Step['state'], string> = { done: '✓', current: '●', pending: '○' }

/** The hero card: the state line with its dot, the headline, the sentence, then the idle foot or the running progress and steps. */
export const heroSvg = (W: number, h: Hero): Drawing => {
  const inner = W - HERO_PAD * 2
  const color = h.kind === 'history' ? DONE : h.kind === 'running' ? ACCENT : MUTED
  const lines = wrapText(h.line, 12.5, inner)
  const parts: string[] = []
  parts.push(dot(HERO_PAD + 4, 29, color, h.kind === 'running'))
  parts.push(`<text ${startText(HERO_PAD + 14, 33)} font-size="11" font-weight="650" fill="${color}" letter-spacing="0.6">${xml(h.state)}</text>`)
  const headSize = h.kind === 'running' ? 20 : 22
  parts.push(`<text class="t" ${startText(HERO_PAD, 64)} font-size="${headSize}" font-weight="700" letter-spacing="-0.5">${xml(fitText(h.headline, headSize, inner))}</text>`)
  let y = 86
  for (const l of lines) {
    parts.push(`<text class="s" ${startText(HERO_PAD, y)} font-size="12.5">${xml(l)}</text>`)
    y += 19
  }
  if (h.progress) {
    const { done, total } = h.progress
    const pct = total ? Math.round((Math.min(done, total) / total) * 100) : 0
    y += 8
    parts.push(`<text class="s" ${startText(HERO_PAD, y)} font-size="11.5">${done} of ${total} task${total === 1 ? '' : 's'} accepted</text>`)
    parts.push(`<text class="t" ${endText(W - HERO_PAD, y)} font-size="11.5" font-weight="650" font-variant-numeric="tabular-nums">${pct}%</text>`)
    y += 9
    parts.push(`<rect class="k" x="${HERO_PAD}" y="${y}" width="${inner}" height="7" rx="3.5"/>`)
    const fillW = Math.round((inner * pct) / 100)
    if (fillW > 0) parts.push(`<rect x="${HERO_PAD}" y="${y}" width="${Math.max(7, fillW)}" height="7" rx="3.5" fill="${ACCENT}"/>`)
    y += 29
  }
  if (h.steps?.length) {
    const n = h.steps.length
    h.steps.forEach((s, i) => {
      const x = HERO_PAD + (inner * i) / (n - 1)
      const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'
      const fill = STEP_COLOR[s.state] ? `fill="${STEP_COLOR[s.state]}"` : 'class="m"'
      parts.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="10.5" font-weight="${s.state === 'pending' ? 500 : 650}" ${fill}>${STEP_MARK[s.state]} ${xml(s.name)}</text>`)
    })
    y += 12
  }
  if (h.chip) {
    y += 10
    const chipW = Math.round(textWidth(h.chip, 11) + 20)
    parts.push(`<rect class="k" x="${HERO_PAD}" y="${y}" width="${chipW}" height="26" rx="7"/>`)
    parts.push(`<text class="t" ${startText(HERO_PAD + 10, y + 17)} font-size="11">${xml(h.chip)}</text>`)
    if (h.hint) parts.push(`<text class="m" ${endText(W - HERO_PAD, y + 17)} font-size="11">${xml(h.hint)}</text>`)
    y += 26
  }
  const height = y + HERO_PAD
  return { source: svg(W, height, `<rect class="hero" x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="11"/>${parts.join('')}`), height }
}

// ---------- the metric tiles ----------

export type Metric = { value: number | string; label: string; color?: string }
export const METRICS_H = 62

/** A row of compact tiles: the number, then a dot in the metric's colour and its label. */
export const metricsSvg = (W: number, list: Metric[]): string => {
  const gap = 8
  const n = Math.max(1, list.length)
  const tw = (W - gap * (n - 1)) / n
  const body = list
    .map((m, i) => {
      const x = i * (tw + gap)
      return `<rect class="tile" x="${x + 0.5}" y="0.5" width="${tw - 1}" height="${METRICS_H - 1}" rx="9"/>
<text class="t" ${startText(x + 13, 27)} font-size="21" font-weight="680" letter-spacing="-0.6" font-variant-numeric="tabular-nums">${xml(String(m.value))}</text>
<circle cx="${x + 16}" cy="${44}" r="3" fill="${m.color ?? '#8d889b'}"/>
<text class="s" ${startText(x + 24, 48)} font-size="11">${xml(fitText(m.label, 11, tw - 36))}</text>`
    })
    .join('')
  return svg(W, METRICS_H, body)
}

// ---------- the agent card ----------

export type AgentCard = {
  role: string
  model: string
  effort?: string
  status: AgentRun['status']
  activity: string
  /** Elapsed over the task limit, 0 to 1; nothing draws an empty bar. */
  progress: number
  calls: number
  tokens: number
  elapsedMs: number
}
export const AGENT_CARD_H = 118
const CARD_PAD = 15

/** One running agent: its role, model and effort, its status, activity, a thin bar of its time against the limit, calls, tokens and elapsed. */
export const agentCardSvg = (W: number, c: AgentCard): string => {
  const color = c.status === 'failed' ? FAILED : c.status === 'done' ? DONE : ACCENT
  const word = c.status === 'running' ? 'Running' : c.status === 'failed' ? 'Failed' : 'Done'
  const statusW = textWidth(word, 11) + 16
  const inner = W - CARD_PAD * 2
  const meta = [modelName(c.model), c.effort].filter(Boolean).join(' · ')
  const barW = inner
  const fillW = Math.round(barW * Math.min(1, Math.max(0, c.progress)))
  return svg(
    W,
    AGENT_CARD_H,
    `<rect class="card" x="0.5" y="0.5" width="${W - 1}" height="${AGENT_CARD_H - 1}" rx="10"/>
<text class="t" ${startText(CARD_PAD, 28)} font-size="13.5" font-weight="650">${xml(fitText(c.role, 13.5, inner - statusW - 8))}</text>
<text class="m" ${startText(CARD_PAD, 44)} font-size="10.5">${xml(fitText(meta, 10.5, inner - statusW - 8))}</text>
${dot(W - CARD_PAD - statusW + 4, 25, color, c.status === 'running')}
<text ${endText(W - CARD_PAD, 29)} font-size="11" font-weight="620" fill="${color}">${xml(word)}</text>
<text class="t" ${startText(CARD_PAD, 68)} font-size="12">${xml(fitText(c.activity || '—', 12, inner))}</text>
<rect class="k" x="${CARD_PAD}" y="80" width="${barW}" height="5" rx="2.5"/>${fillW > 0 ? `<rect x="${CARD_PAD}" y="80" width="${Math.max(5, fillW)}" height="5" rx="2.5" fill="${color}"/>` : ''}
<text class="m" ${startText(CARD_PAD, 103)} font-size="11">${c.calls} tool call${c.calls === 1 ? '' : 's'} · ${fmtTokens(c.tokens)} tokens</text>
<text class="m" ${endText(W - CARD_PAD, 103)} font-size="11" font-variant-numeric="tabular-nums">${fmtTime(c.elapsedMs)}</text>`,
  )
}

// ---------- the list rows ----------

export const ROW_H = 54
export const MERGED_ROW_H = 40
export const SESSION_ROW_H = 36
const ROW_PAD = 13

/** The tag's colour per kind: purple for what runs, green for ready and merged, amber for blocked or no spec, grey otherwise. */
export const TAG_COLOR: Record<TagKind, string> = { running: ACCENT, done: DONE, blocked: BLOCKED, ready: DONE, muted: MUTED }

export type ItemRowDrawing = {
  id: string
  title: string
  /** `M · Inbox`; the reason is in the tag, not here. */
  meta: string
  tag: { text: string; kind: TagKind }
  /** The last row of its card draws no hairline under itself. */
  isLast?: boolean
}

const hairline = (W: number, H: number, isLast: boolean | undefined): string => (isLast ? '' : `<rect class="hair" x="0" y="${H - 1}" width="${W}" height="1"/>`)

/**
 * A row of a list card, as the mockup's .item-row: the id in a bordered chip, the title cut with an ellipsis over
 * its meta line, and the status tag at the right. The chevron beside it is a Button, since a Button holds only text.
 */
export const itemRowSvg = (W: number, r: ItemRowDrawing): string => {
  const H = ROW_H
  const idW = Math.max(39, Math.round(textWidth(r.id, 11) + 16))
  const color = TAG_COLOR[r.tag.kind]
  const tagW = Math.round(textWidth(r.tag.text, 10) + 14)
  const tagX = W - ROW_PAD - tagW
  const textX = ROW_PAD + idW + 12
  const textW = Math.max(0, tagX - 10 - textX)
  return svg(
    W,
    H,
    `<rect class="chip" x="${ROW_PAD + 0.5}" y="14.5" width="${idW - 1}" height="25" rx="7"/>
<text x="${ROW_PAD + idW / 2}" y="31" text-anchor="middle" font-size="11" font-weight="660" fill="${r.tag.kind === 'done' ? DONE : ACCENT}">${xml(r.id)}</text>
<text class="t" ${startText(textX, 24)} font-size="12" font-weight="590">${xml(fitText(r.title, 12, textW))}</text>
<text class="m" ${startText(textX, 40)} font-size="11">${xml(fitText(r.meta, 11, textW))}</text>
<rect x="${tagX}" y="17" width="${tagW}" height="20" rx="6" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-opacity="0.4"/>
<text x="${tagX + tagW / 2}" y="31" text-anchor="middle" font-size="10" font-weight="600" fill="${color}">${xml(r.tag.text)}</text>
${hairline(W, H, r.isLast)}`,
  )
}

/** A merged row, as the mockup's .merged-row: a green check, the id in muted text, the title cut; the PR link stands beside it. */
export const mergedRowSvg = (W: number, r: { id: string; title: string; isLast?: boolean }): string => {
  const H = MERGED_ROW_H
  const cx = ROW_PAD + 8
  const idX = ROW_PAD + 24
  const titleX = idX + textWidth(r.id, 11) + 10
  return svg(
    W,
    H,
    `<circle cx="${cx}" cy="20" r="7.5" fill="none" stroke="${DONE}" stroke-width="1.8"/>
<path d="m${cx - 4} 20.5 3 3 5.5-6.5" fill="none" stroke="${DONE}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
<text class="m" ${startText(idX, 24)} font-size="11">${xml(r.id)}</text>
<text class="t" ${startText(titleX, 24)} font-size="12" font-weight="520">${xml(fitText(r.title, 12, Math.max(0, W - ROW_PAD - titleX)))}</text>
${hairline(W, H, r.isLast)}`,
  )
}

/** Another session's row: a dot (purple while an agent runs), its title cut, then `p12 · 2 agents · stale` at the right; a stale one is faded. */
export const sessionRowSvg = (W: number, r: { title: string; meta: string; isLive: boolean; isStale: boolean; isLast?: boolean }): string => {
  const H = SESSION_ROW_H
  const metaW = textWidth(r.meta, 11)
  const titleX = ROW_PAD + 16
  const titleW = Math.max(0, W - ROW_PAD - metaW - 12 - titleX)
  return svg(
    W,
    H,
    `<g${r.isStale ? ' opacity="0.5"' : ''}>${dot(ROW_PAD + 4, 18, r.isLive && !r.isStale ? ACCENT : MUTED, r.isLive && !r.isStale)}
<text class="t" ${startText(titleX, 22)} font-size="12" font-weight="590">${xml(fitText(r.title, 12, titleW))}</text>
<text class="m" ${endText(W - ROW_PAD, 22)} font-size="11">${xml(r.meta)}</text></g>
${hairline(W, H, r.isLast)}`,
  )
}

// ---------- the band above the prompt ----------

export const BAND_H = 54
export const BAND_COMPACT_H = 28
/** The segmented bar's width: narrower on a narrow band. */
const segmentsWidth = (W: number): number => (W < 400 ? 84 : 145)

const BAND_CSS = `<style>
text{font-family:${FONT}}
.t{fill:#1f1f1f}.s{fill:#56554f}.m{fill:#83827c}.bg{fill:#f4f3ef;stroke:#dcdad3}.sep{fill:#cfcdc6}
@media (prefers-color-scheme: dark){.t{fill:#f0eff2}.s{fill:#a4a2ac}.m{fill:#a5a1af}.bg{fill:#25242a;stroke:#494153}.sep{fill:#43404a}}
.live{animation:p 2.2s ease-in-out infinite}@keyframes p{50%{opacity:.45}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

/**
 * The band as one SVG. Two lines: the dot, the id, the title (what is left, cut with an ellipsis), the state tag, a
 * separator and the task count; then the segmented bar, the activity line and the clock at the right. Compact: one
 * line of dot, id, title, count and clock. Everything is measured against `W`, so nothing runs past the edge.
 */
export const bandSvg = (b: Band, W: number, isCompact = false): string => {
  const H = isCompact ? BAND_COMPACT_H : BAND_H
  const isLive = /^(PLANNING|BUILDING|REVIEW)$/.test(b.state)
  const y1 = isCompact ? 18 : 20
  const pad = 13
  const parts: string[] = []
  parts.push(`<rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="9"/>`)
  parts.push(`<rect x="0" y="6" width="2" height="${H - 12}" fill="${b.color}"/>`)
  parts.push(`<circle${isLive ? ' class="live"' : ''} cx="${pad + 3.5}" cy="${y1 - 4}" r="3.5" fill="${b.color}"/>`)
  const idX = pad + 16
  const idW = textWidth(b.id, 11)
  // The right side, measured from the edge: the clock (compact) or the count, the separator and the state tag.
  let right = W - pad
  if (isCompact && b.clock) {
    const w = textWidth(b.clock, 11)
    parts.push(`<text class="m" ${endText(right, y1)} font-size="11" font-variant-numeric="tabular-nums">${xml(b.clock)}</text>`)
    right -= w + 12
  }
  if (b.count) {
    const w = textWidth(b.count, 11)
    parts.push(`<text ${endText(right, y1)} font-size="11" font-weight="600" font-variant-numeric="tabular-nums" fill="${isCompact ? b.color : ''}" class="${isCompact ? '' : 't'}">${xml(b.count)}</text>`)
    right -= w + 10
  }
  if (!isCompact && b.state) {
    const w = textWidth(b.state, 9) + 14 + b.state.length * 0.6
    // At a narrow width the tag would sit on the id: it goes, as in compact mode, and the title keeps the room.
    if (right - 10 - w >= idX + idW + 24) {
      parts.push(`<rect class="sep" x="${right - 1}" y="${y1 - 11}" width="1" height="13"/>`)
      right -= 10
      parts.push(`<rect x="${right - w}" y="${y1 - 12}" width="${w}" height="17" rx="5" fill="${b.color}" fill-opacity="0.12" stroke="${b.color}" stroke-opacity="0.3"/>`)
      parts.push(`<text ${endText(right - 7, y1)} font-size="9" font-weight="700" letter-spacing="0.6" fill="${b.color}">${xml(b.state)}</text>`)
      right -= w + 10
    }
  }
  parts.push(`<text class="s" ${startText(idX, y1)} font-size="11" font-weight="650" font-variant-numeric="tabular-nums">${xml(b.id)}</text>`)
  const titleX = idX + idW + 9
  const titleW = right - titleX
  if (titleW > 24) parts.push(`<text class="t" ${startText(titleX, y1)} font-size="12" font-weight="${isCompact ? 590 : 650}">${xml(fitText(b.title, 12, titleW))}</text>`)
  if (!isCompact) {
    const y2 = 44
    const segX = idX
    const segW = segmentsWidth(W)
    const n = Math.max(1, b.segments.length)
    const gap = 4
    const each = (segW - gap * (n - 1)) / n
    b.segments.forEach((seg, i) => parts.push(`<rect x="${segX + i * (each + gap)}" y="${y2 - 8}" width="${each}" height="5" rx="2.5" fill="${seg === 'current' ? b.color : SEGMENT_COLORS[seg]}"/>`))
    if (!b.segments.length) parts.push(`<rect x="${segX}" y="${y2 - 8}" width="${segW}" height="5" rx="2.5" fill="${SEGMENT_COLORS.pending}"/>`)
    const clockW = textWidth(b.clock, 11)
    parts.push(`<text class="m" ${endText(W - pad, y2)} font-size="11" font-variant-numeric="tabular-nums">${xml(b.clock)}</text>`)
    const actX = segX + segW + 13
    const actW = W - pad - clockW - 13 - actX
    if (actW > 24) parts.push(`<text class="s" ${startText(actX, y2)} font-size="11">${xml(fitText(b.activity, 11, actW))}</text>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${BAND_CSS}${parts.join('')}</svg>`
}

/** The terminal's row: `● p1 · Task 1 / 3 · ▰▱▱ · Implementer · 3:44`, as pieces, cut to `cols` columns from the activity first. */
export const bandText = (b: Band, cols: number): { head: string; segments: string; tail: string } => {
  const head = `● ${[b.id, b.count].filter(Boolean).join(' · ')}`
  const segments = b.segments.map(s => (s === 'pending' ? '▱' : '▰')).join('') || '▱'
  const fixed = `${head} · ${segments} · `
  const room = cols - fixed.length - b.clock.length - 3
  const activity = room >= 4 ? (b.activity.length > room ? b.activity.slice(0, room - 1).trimEnd() + '…' : b.activity) : ''
  const tail = [activity, b.clock].filter(Boolean).join(' · ')
  const whole = fixed + tail
  return whole.length <= cols ? { head, segments, tail } : { head: head.slice(0, Math.max(0, cols - 1)) + '…', segments: '', tail: '' }
}
