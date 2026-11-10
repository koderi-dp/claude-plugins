// The desktop drawings: SVG strings for the dashboard's hero, metric tiles, rows, task list and the band above
// the prompt, each composed from the kit (ui/kit.ts) with the tokens (ui/tokens.ts); no colour is written here.
// The text sizing and the pricing came from savvy-flow (MIT, LICENSE-savvy beside this plugin) through
// superpowers-flow. Pure: strings in, strings out, no engine.

import type { AgentRun } from '../types'
import type { Band, Segment, Step, TagKind, TaskRow } from './status'
import { fmtDuration } from './status'
import type { IconName, Piece, Seg } from './ui/kit'
import { BADGE_H, BAR_H, TAB_UNDERLINE_H, badge, check, disc, divider, dot, frame, icon, progress, segments, separator, soft, surface, tabUnderline, text, textWidth, wrapText } from './ui/kit'
import type { Role, Tone } from './ui/tokens'
import { ACCENT, BLOCKED, DONE, MUTED, RADIUS, SIZE, SPACE, WEIGHT, fillClass, toneOf } from './ui/tokens'

// The names the rest of the plugin imports from here: the colours (the tokens' dark values) and the text measures.
export { ACCENT, BLOCKED, CARD_BORDER, DONE, FAILED, FONT, LINE, MUTED } from './ui/tokens'
export { fitText, textWidth, wrapText, xml } from './ui/kit'

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

// ---------- the shared measures ----------

/** A card's padding, and a row's. */
const PAD = SPACE[4]
const ROW_PAD = SPACE[3]
/** The gap between a row's leading piece, its text and its trailing piece. */
const ROW_GAP = 10

export type Drawing = { source: string; height: number }

// ---------- the tabs ----------

export { TAB_UNDERLINE_H }
/** The size the app draws a Button's label at, about; a tab's underline is measured with it. */
const TAB_LABEL_SIZE = 13

/** The width of the underline under a tab's label. */
export const tabWidth = (label: string): number => Math.ceil(textWidth(label, TAB_LABEL_SIZE))

/** The underline of one tab, as wide as its label: a primary bar when active, an empty drawing of the same size when not. */
export const tabUnderlineSvg = (W: number, isActive: boolean): string => frame(W, TAB_UNDERLINE_H, tabUnderline(0, 0, W, isActive))

/** The hairline under the row of tabs. */
export const separatorSvg = (W: number): string => frame(W, 1, separator(0, 0, W))

// ---------- the hero ----------

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

const HERO_TONE: Record<Hero['kind'], Tone> = { idle: 'neutral', running: 'primary', history: 'success' }
const STEP_ICON: Record<Step['state'], IconName> = { done: 'check', current: 'circle-dot', pending: 'circle' }
const STEP_ROLE: Record<Step['state'], Role> = { done: 'success', current: 'primary', pending: 'subtle' }
const STEP_ICON_W = 12

/** The hero card: the state line with its dot, the headline, the sentence, then the idle foot or the running progress and steps. */
export const heroSvg = (W: number, h: Hero): Drawing => {
  const inner = W - PAD * 2
  const tone = HERO_TONE[h.kind]
  const parts: string[] = []
  parts.push(dot(PAD + 3.5, 26.5, tone, h.kind === 'running'))
  parts.push(text(PAD + 14, 30, h.state, { size: SIZE.xs, weight: WEIGHT.semibold, role: tone, tracking: 0.6, maxW: inner - 14 }))
  parts.push(text(PAD, 55, h.headline, { size: SIZE.lg, weight: WEIGHT.semibold, tracking: -0.2, maxW: inner }))
  let y = 76
  for (const l of wrapText(h.line, SIZE.base, inner)) {
    parts.push(text(PAD, y, l, { role: 'mutedForeground' }))
    y += 18
  }
  // `bottom` is where the content ends; the card's padding follows it.
  let bottom = y - 18 + 5
  if (h.progress) {
    const { done, total } = h.progress
    const value = total ? Math.min(done, total) / total : 0
    y = bottom + 20
    parts.push(text(PAD, y, `${done} of ${total} task${total === 1 ? '' : 's'} accepted`, { size: SIZE.sm, role: 'mutedForeground' }))
    parts.push(text(W - PAD, y, `${Math.round(value * 100)}%`, { size: SIZE.sm, weight: WEIGHT.semibold, anchor: 'end', isTabular: true }))
    parts.push(progress(PAD, y + 8, inner, value, 'primary'))
    bottom = y + 8 + BAR_H
  }
  if (h.steps?.length) {
    const count = h.steps.length
    y = bottom + 22
    h.steps.forEach((s, i) => {
      const groupW = STEP_ICON_W + 5 + textWidth(s.name, SIZE.sm)
      const x = i === 0 ? PAD : i === count - 1 ? W - PAD - groupW - 2 : PAD + (inner * i) / (count - 1) - groupW / 2
      const isEnd = count > 1 && i === count - 1
      parts.push(icon(STEP_ICON[s.state], x, y - 10, STEP_ICON_W, STEP_ROLE[s.state]))
      // The last step's name ends at the padding whatever its measured width.
      parts.push(text(isEnd ? W - PAD : x + STEP_ICON_W + 5, y, s.name, { size: SIZE.sm, weight: s.state === 'pending' ? WEIGHT.regular : WEIGHT.medium, role: STEP_ROLE[s.state], ...(isEnd ? { anchor: 'end' as const } : {}) }))
    })
    bottom = y + 4
  }
  if (h.chip) {
    y = bottom + 14
    parts.push(badge(PAD, y, h.chip, { tone: 'neutral', variant: 'outline' }).svg)
    if (h.hint) parts.push(text(W - PAD, y + 12.5, h.hint, { size: SIZE.sm, role: 'subtle', anchor: 'end' }))
    bottom = y + BADGE_H
  }
  const height = Math.round(bottom + PAD)
  return { source: frame(W, height, surface(0, 0, W, height, { variant: 'primary' }) + parts.join('')), height }
}

// ---------- the metric tiles ----------

export type Metric = { value: number | string; label: string; color?: string }
export const METRICS_H = 62

/** A row of tiles on the card surface: a small uppercase label over the number; the number in the metric's tone when it has a colour. */
export const metricsSvg = (W: number, list: Metric[]): string => {
  const gap = SPACE[2]
  const count = Math.max(1, list.length)
  const tw = (W - gap * (count - 1)) / count
  const body = list
    .map((m, i) => {
      const x = i * (tw + gap)
      const tone = toneOf(m.color)
      return (
        surface(x, 0, tw, METRICS_H) +
        text(x + ROW_PAD, 22, m.label.toUpperCase(), { size: SIZE.xs, weight: WEIGHT.medium, role: 'mutedForeground', tracking: 0.6, maxW: tw - ROW_PAD * 2 }) +
        text(x + ROW_PAD, 47, String(m.value), { size: SIZE.xl, weight: WEIGHT.semibold, tracking: -0.3, isTabular: true, maxW: tw - ROW_PAD * 2, ...(tone === 'neutral' ? {} : { role: tone }) })
      )
    })
    .join('')
  return frame(W, METRICS_H, body)
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

/** One running agent: its role, model and effort, its status, activity, a thin bar of its time against the limit, calls, tokens and elapsed. */
export const agentCardSvg = (W: number, c: AgentCard): string => {
  const tone: Tone = c.status === 'failed' ? 'destructive' : c.status === 'done' ? 'success' : 'primary'
  const word = c.status === 'running' ? 'Running' : c.status === 'failed' ? 'Failed' : 'Done'
  const inner = W - PAD * 2
  const status = badge(W - PAD, 14, word, { tone, anchor: 'end', dot: c.status === 'running' ? 'live' : 'still' })
  const headW = inner - status.width - ROW_GAP
  const meta = [modelName(c.model), c.effort].filter(Boolean).join(' · ')
  return frame(
    W,
    AGENT_CARD_H,
    surface(0, 0, W, AGENT_CARD_H) +
      text(PAD, 28, c.role, { size: SIZE.md, weight: WEIGHT.semibold, maxW: headW }) +
      text(PAD, 44, meta, { size: SIZE.sm, role: 'subtle', maxW: headW }) +
      status.svg +
      text(PAD, 68, c.activity || '—', { maxW: inner }) +
      progress(PAD, 79, inner, c.progress, tone) +
      text(PAD, 103, `${c.calls} tool call${c.calls === 1 ? '' : 's'} · ${fmtTokens(c.tokens)} tokens`, { size: SIZE.sm, role: 'subtle' }) +
      text(W - PAD, 103, fmtTime(c.elapsedMs), { size: SIZE.sm, role: 'subtle', anchor: 'end', isTabular: true }),
  )
}

// ---------- the list rows ----------

export const ROW_H = 54
export const MERGED_ROW_H = 40
export const SESSION_ROW_H = 36

/** The tag's colour per kind: purple for what runs, green for ready and merged, amber for blocked or no spec, grey otherwise. */
export const TAG_COLOR: Record<TagKind, string> = { running: ACCENT, done: DONE, blocked: BLOCKED, ready: DONE, muted: MUTED }

type RowSpec = {
  /** The piece at the row's start, given its left edge and the row's middle. */
  leading?: (x: number, cy: number) => Piece
  title: string
  titleRole?: Role
  /** The line under the title. */
  meta?: string
  /** The piece at the row's end, given its right edge and the row's middle. */
  trailing?: (right: number, cy: number) => Piece
  isFaded?: boolean
  /** The last row of its card draws no hairline under itself. */
  isLast?: boolean | undefined
}

/** The one row layout: leading piece, the title cut to what is left (over its meta line), trailing piece, the hairline. */
const row = (W: number, H: number, r: RowSpec): string => {
  const cy = H / 2
  const lead = r.leading?.(ROW_PAD, cy)
  const trail = r.trailing?.(W - ROW_PAD, cy)
  const textX = ROW_PAD + (lead ? lead.width + ROW_GAP : 0)
  const textW = Math.max(0, W - ROW_PAD - (trail ? trail.width + ROW_GAP : 0) - textX)
  const body =
    (lead?.svg ?? '') +
    text(textX, r.meta === undefined ? cy + 4 : cy - 4, r.title, { weight: WEIGHT.medium, role: r.titleRole ?? 'foreground', maxW: textW }) +
    (r.meta === undefined ? '' : text(textX, cy + 12, r.meta, { size: SIZE.sm, role: 'subtle', maxW: textW })) +
    (trail?.svg ?? '')
  return frame(W, H, (r.isFaded ? `<g opacity="0.5">${body}</g>` : body) + (r.isLast ? '' : separator(0, H - 1, W)))
}

export type ItemRowDrawing = {
  id: string
  title: string
  /** `M · Inbox`; the reason is in the tag, not here. */
  meta: string
  tag: { text: string; kind: TagKind }
  /** The last row of its card draws no hairline under itself. */
  isLast?: boolean
}

const TAG_TONE: Record<TagKind, Tone> = { running: 'primary', done: 'success', blocked: 'warning', ready: 'success', muted: 'neutral' }

/**
 * A row of a list card: the id in an outlined badge, the title cut with an ellipsis over its meta line, and the
 * status badge at the right. The chevron beside it is a Button, since a Button holds only text.
 */
export const itemRowSvg = (W: number, r: ItemRowDrawing): string =>
  row(W, ROW_H, {
    leading: (x, cy) => badge(x, cy - BADGE_H / 2, r.id, { tone: r.tag.kind === 'done' ? 'success' : 'primary', variant: 'outline', minW: 38 }),
    title: r.title,
    meta: r.meta,
    trailing: (right, cy) => badge(right, cy - BADGE_H / 2, r.tag.text, { tone: TAG_TONE[r.tag.kind], anchor: 'end' }),
    isLast: r.isLast,
  })

/** A merged row: a green ringed check, the id in the subtle grey, the title cut; the PR link stands beside it. */
export const mergedRowSvg = (W: number, r: { id: string; title: string; isLast?: boolean }): string =>
  row(W, MERGED_ROW_H, {
    leading: (x, cy) => ({ svg: check(x + 8, cy) + text(x + 24, cy + 4, r.id, { size: SIZE.sm, role: 'subtle' }), width: 24 + textWidth(r.id, SIZE.sm) }),
    title: r.title,
    isLast: r.isLast,
  })

/** Another session's row: a dot (purple while an agent runs), its title cut, then `p12 · 2 agents · stale` at the right; a stale one is faded, an idle one's title is in the subtle grey. */
export const sessionRowSvg = (W: number, r: { title: string; meta: string; isLive: boolean; isStale: boolean; isDim?: boolean; isLast?: boolean }): string => {
  const isLive = r.isLive && !r.isStale
  return row(W, SESSION_ROW_H, {
    leading: (x, cy) => ({ svg: dot(x + 3.5, cy, isLive ? 'primary' : 'neutral', isLive), width: 7 }),
    title: r.title,
    titleRole: r.isDim ? 'subtle' : 'foreground',
    trailing: (right, cy) => ({ svg: text(right, cy + 4, r.meta, { size: SIZE.sm, role: 'subtle', anchor: 'end' }), width: textWidth(r.meta, SIZE.sm) }),
    isFaded: r.isStale,
    isLast: r.isLast,
  })
}

// ---------- a caption line ----------

export const CAPTION_H = 20

/** A line of small text between drawings: the usage line under the hero, the footer; `right` stands at the far edge, in mono when asked. */
export const captionSvg = (W: number, left: string, right = '', isRightMono = false): string => {
  // A mono character advances about 0.62 em whatever it is.
  const rightW = right ? (isRightMono ? [...right].length * SIZE.sm * 0.62 : textWidth(right, SIZE.sm)) + ROW_GAP : 0
  return frame(
    W,
    CAPTION_H,
    text(0, 14, left, { size: SIZE.sm, role: 'mutedForeground', isTabular: true, maxW: W - rightW }) + (right ? text(W, 14, right, { size: SIZE.sm, role: 'subtle', anchor: 'end', isMono: isRightMono }) : ''),
  )
}

// ---------- the task list of the running Overview ----------

export const TASK_BAR_H = BAR_H
const TASK_BAR_GAP = 5

/** How a task's segment is painted: green accepted, purple in progress, amber blocked, the empty track pending. */
const segOf = (s: Segment, current: Tone, isStriped: boolean): Seg => (s === 'accepted' ? { tone: 'success' } : s === 'current' ? { tone: current, isStriped } : s === 'blocked' ? { tone: 'warning' } : { tone: 'track' })

/** The segmented task bar: one rounded segment per task, green accepted, striped purple current, the track pending, amber blocked. */
export const taskBarSvg = (W: number, list: Segment[]): string =>
  frame(
    W,
    TASK_BAR_H,
    segments(
      0,
      0,
      W,
      list.map(s => segOf(s, 'primary', true)),
      { gap: TASK_BAR_GAP },
    ),
  )

const RAIL_X = 12
const MARK_R = 11.5
const TASK_X = 36
const CARD_X = 28
const CARD_PAD = SPACE[3]
const KIND_ROLE: Record<TaskRow['kind'], Role> = { done: 'success', current: 'primary', pending: 'subtle', blocked: 'warning' }
const BADGE_TONE: Record<TaskRow['badgeKind'], Tone> = { done: 'success', running: 'primary', pending: 'neutral', blocked: 'warning' }
const HISTORY_ROLE: Record<TaskRow['history'][number]['kind'], Role> = { done: 'success', blocked: 'warning', muted: 'mutedForeground' }
/** The badge's text may open with a dot glyph; the badge draws its own, pulsing. */
const LIVE_MARK = '● '

/** The marker on the rail: a check in a green disc, a purple ring with a pulsing dot, the number in a plain ring, or an amber cross. */
const marker = (r: TaskRow, cy: number): string => {
  switch (r.kind) {
    case 'done':
      return disc(RAIL_X, cy, MARK_R, 'success') + icon('check', RAIL_X - 6, cy - 6, 12, 'success')
    case 'current':
      return disc(RAIL_X, cy, MARK_R, 'primary', true) + dot(RAIL_X, cy, 'primary', true, { r: 4 })
    case 'blocked':
      return disc(RAIL_X, cy, MARK_R, 'warning', true) + icon('x', RAIL_X - 6, cy - 6, 12, 'warning')
    default:
      return disc(RAIL_X, cy, MARK_R, 'plain') + text(RAIL_X, cy + 3.5, String(r.n).padStart(2, '0'), { size: SIZE.xs, weight: WEIGHT.semibold, role: 'subtle', anchor: 'middle', isTabular: true })
  }
}

/**
 * One task of the list: the rail with its marker, the eyebrow and the badge, the title (two lines at most) and the
 * sub-line; the current task in the purple-tinted card that holds the agent block (role, model, Active, the activity
 * strip, the metrics) or the lead line with its history rows. Compact keeps the eyebrow, the badge, the title and
 * the current task's activity strip.
 */
export const taskRowSvg = (W: number, r: TaskRow, o: { isFirst: boolean; isLast: boolean; isCompact: boolean }): Drawing => {
  const isCard = r.kind === 'current'
  const pad = isCard ? CARD_PAD : 0
  const x0 = isCard ? CARD_X + pad : TASK_X
  const right = isCard ? W - 1 - pad : W - 2
  const contentW = right - x0
  const parts: string[] = []
  let y = (isCard ? 2 + pad : 12) + 11
  const cy = y - 4
  // The heading: the eyebrow left, the badge right.
  const isLive = r.badge.startsWith(LIVE_MARK)
  const tag = badge(right, y - 13, isLive ? r.badge.slice(LIVE_MARK.length) : r.badge, { tone: BADGE_TONE[r.badgeKind], anchor: 'end', ...(isLive ? { dot: 'live' as const } : {}) })
  parts.push(text(x0, y, r.eyebrow, { size: SIZE.xs, weight: WEIGHT.semibold, role: KIND_ROLE[r.kind], tracking: 0.6, maxW: contentW - tag.width - ROW_GAP }))
  parts.push(tag.svg)
  // The title, then the sub-line.
  wrapText(r.title, SIZE.base, contentW, 2).forEach((l, i) => {
    y += i === 0 ? 22 : 17
    parts.push(text(x0, y, l, { weight: WEIGHT.medium, role: r.kind === 'pending' ? 'mutedForeground' : 'foreground' }))
  })
  if (!o.isCompact && r.sub) {
    y += 17
    parts.push(text(x0, y, r.sub, { size: SIZE.sm, role: 'subtle', maxW: contentW }))
  }
  const strip = (activity: string) => {
    parts.push(surface(x0, y, contentW, 32, { radius: RADIUS.md }))
    parts.push(icon('terminal', x0 + 10, y + 9, 14, 'primary'))
    parts.push(text(x0 + 32, y + 20, activity, { size: SIZE.sm, maxW: contentW - 42 }))
    y += 32
  }
  if (isCard && !o.isCompact && (r.agent || r.lead)) {
    y += 13
    parts.push(separator(x0, y, contentW))
    y += 13
    if (r.agent) {
      const activeW = textWidth('Active', SIZE.sm)
      parts.push(soft(x0, y, 28, 28, 'primary'))
      parts.push(icon('bot', x0 + 6, y + 6, 16, 'primary'))
      parts.push(text(x0 + 38, y + 12, r.agent.role, { size: SIZE.sm, weight: WEIGHT.semibold, maxW: contentW - 38 - activeW - 24 }))
      parts.push(text(x0 + 38, y + 25, r.agent.model, { size: SIZE.xs, role: 'subtle', maxW: contentW - 38 - activeW - 24 }))
      parts.push(dot(right - activeW - 6, y + 14, 'primary', true, { r: 3 }))
      parts.push(text(right, y + 18, 'Active', { size: SIZE.sm, role: 'primary', anchor: 'end' }))
      y += 38
      strip(r.agent.activity)
      y += 11
      parts.push(text(x0, y + 8, `${r.agent.calls} tool calls · ${fmtTokens(r.agent.tokens)} tokens · ${fmtDuration(r.agent.elapsedMs)} elapsed`, { size: SIZE.sm, role: 'subtle', maxW: contentW }))
      y += 12
    } else {
      parts.push(text(x0, y + 10, r.lead ?? '', { size: SIZE.sm, weight: WEIGHT.medium, role: 'primary', maxW: contentW }))
      y += 18
      for (const h of r.history) {
        y += 6
        parts.push(surface(x0, y, contentW, 28, { radius: RADIUS.md }))
        parts.push(text(x0 + 10, y + 18, h.text, { size: SIZE.sm, role: HISTORY_ROLE[h.kind], maxW: contentW - 20 }))
        y += 28
      }
    }
  } else if (isCard && o.isCompact && r.agent) {
    y += 10
    strip(r.agent.activity)
  }
  y += isCard ? pad + 1 : o.isCompact ? 10 : 15
  const H = isCard ? y + 6 : y
  // The rail stops at the marker's edge on both sides: the marker's fill is faint, the line would show through it.
  const above = o.isFirst ? '' : `<rect x="${RAIL_X - 0.5}" y="0" width="1" height="${cy - MARK_R}" class="${fillClass('border')}"/>`
  const below = o.isLast ? '' : `<rect x="${RAIL_X - 0.5}" y="${cy + MARK_R}" width="1" height="${H - cy - MARK_R}" class="${fillClass('border')}"/>`
  const card = isCard ? surface(CARD_X, 2, W - 1 - CARD_X, H - 8, { variant: 'primary' }) : ''
  return { source: frame(W, H, `${above}${below}${card}${marker(r, cy)}${parts.join('')}`), height: H }
}

// ---------- the band above the prompt ----------

export const BAND_H = 54
export const BAND_COMPACT_H = 28
/** The segmented bar's width: narrower on a narrow band. */
const segmentsWidth = (W: number): number => (W < 400 ? 84 : 145)

/**
 * The band as one SVG. Two lines: the dot, the id, the title (what is left, cut with an ellipsis), the state badge, a
 * divider and the task count; then the segmented bar, the activity line and the clock at the right. Compact: one
 * line of dot, id, title, count and clock. Everything is measured against `W`, so nothing runs past the edge.
 */
export const bandSvg = (b: Band, W: number, isCompact = false): string => {
  const H = isCompact ? BAND_COMPACT_H : BAND_H
  const isLive = /^(PLANNING|BUILDING|REVIEW)$/.test(b.state)
  const tone = toneOf(b.color)
  const y1 = isCompact ? 18 : 21
  const pad = ROW_PAD
  const parts: string[] = [surface(0, 0, W, H), dot(pad + 3.5, y1 - 4, tone, isLive)]
  const idX = pad + 16
  const idW = textWidth(b.id, SIZE.sm)
  // The right side, measured from the edge: the clock (compact) or the count, the divider and the state badge.
  let right = W - pad
  if (isCompact && b.clock) {
    parts.push(text(right, y1, b.clock, { size: SIZE.sm, role: 'subtle', anchor: 'end', isTabular: true }))
    right -= textWidth(b.clock, SIZE.sm) + 12
  }
  if (b.count) {
    parts.push(text(right, y1, b.count, { size: SIZE.sm, weight: WEIGHT.medium, role: isCompact ? tone : 'foreground', anchor: 'end', isTabular: true }))
    right -= textWidth(b.count, SIZE.sm) + 10
  }
  if (!isCompact && b.state) {
    const tag = badge(right - 10, y1 - 13, b.state, { tone, anchor: 'end', tracking: 0.5 })
    // At a narrow width the badge would sit on the id: it goes, as in compact mode, and the title keeps the room.
    if (right - 10 - tag.width >= idX + idW + 24) {
      parts.push(divider(right - 1, y1 - 10, 12))
      parts.push(tag.svg)
      right -= 10 + tag.width + 10
    }
  }
  parts.push(text(idX, y1, b.id, { size: SIZE.sm, weight: WEIGHT.semibold, role: 'mutedForeground', isTabular: true }))
  const titleX = idX + idW + 9
  const titleW = right - titleX
  if (titleW > 24) parts.push(text(titleX, y1, b.title, { weight: isCompact ? WEIGHT.medium : WEIGHT.semibold, maxW: titleW }))
  if (!isCompact) {
    const y2 = 43
    const segW = segmentsWidth(W)
    parts.push(
      segments(
        idX,
        y2 - 7,
        segW,
        b.segments.map(s => segOf(s, tone, false)),
      ),
    )
    parts.push(text(W - pad, y2, b.clock, { size: SIZE.sm, role: 'subtle', anchor: 'end', isTabular: true }))
    const actX = idX + segW + 12
    const actW = W - pad - textWidth(b.clock, SIZE.sm) - 12 - actX
    if (actW > 24) parts.push(text(actX, y2, b.activity, { size: SIZE.sm, role: 'mutedForeground', maxW: actW }))
  }
  return frame(W, H, parts.join(''))
}

/** The idle strip: one line in the band's frame, a hollow dot in the muted colour and the idle line cut to the width. */
export const idleStripSvg = (line: string, W: number): string => {
  const pad = ROW_PAD
  const textX = pad + 16
  return frame(W, BAND_COMPACT_H, surface(0, 0, W, BAND_COMPACT_H) + dot(pad + 3.5, 14, 'neutral', false, { isHollow: true }) + text(textX, 18, line, { size: SIZE.sm, role: 'mutedForeground', maxW: W - textX - pad }))
}

/** The terminal's idle row: `○ pipeline · idle · 28 inbox · next: p2 …`, cut to `cols` columns with an ellipsis. */
export const idleStripText = (text: string, cols: number): string => {
  const row = `○ ${text}`
  return row.length <= cols ? row : row.slice(0, Math.max(0, cols - 1)).trimEnd() + '…'
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
