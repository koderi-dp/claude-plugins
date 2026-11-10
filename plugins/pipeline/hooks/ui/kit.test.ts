import { expect, test } from 'claude-code/testing'

import { agentCardSvg, bandSvg, captionSvg, heroSvg, idleStripSvg, itemRowSvg, mergedRowSvg, metricsSvg, sessionRowSvg, taskBarSvg, taskRowSvg } from '../draw'
import type { Band, TaskRow } from '../status'
import { BAND_COLORS } from '../status'
import { BADGE_H, ICON_NAMES, badge, check, disc, divider, dot, fitText, frame, icon, progress, segments, separator, soft, stripeId, surface, text, textWidth, xml } from './kit'
import { ACCENT, ALL_COLORS, BLOCKED, COLORS, DONE, FAILED, MUTED, ROLES, STYLE, TONES, fillClass, strokeClass, styleFor, toneOf } from './tokens'

const HEX = /#[0-9a-fA-F]{3,8}\b/g
const styleOf = (svg: string): string => /<style>.*?<\/style>/s.exec(svg)?.[0] ?? ''
const bodyOf = (svg: string): string => svg.replace(/<style>.*?<\/style>/s, '')

test('tokens: every role has a light and a dark value, and the stylesheet carries both schemes with a fill and a stroke class per role', () => {
  for (const role of ROLES) {
    expect(COLORS[role].light).toMatch(/^#[0-9a-f]{6}$/)
    expect(COLORS[role].dark).toMatch(/^#[0-9a-f]{6}$/)
    expect(STYLE).toContain(`.${fillClass(role)}{fill:${COLORS[role].light}}`)
    expect(STYLE).toContain(`.${strokeClass(role)}{stroke:${COLORS[role].light}}`)
  }
  const [light = '', dark = ''] = STYLE.split('@media (prefers-color-scheme: dark)')
  expect(light).toContain(`.t{fill:${COLORS.foreground.light}}`)
  expect(dark).toContain(`.t{fill:${COLORS.foreground.dark}}`)
  expect(dark).toContain(`.f-primary{fill:${COLORS.primary.dark}}`)
  // The live pulse, still under reduced motion.
  expect(STYLE).toContain('.live{animation:')
  expect(STYLE).toContain('prefers-reduced-motion: reduce){.live{animation:none}}')
  // The three text greys keep their short names.
  expect([fillClass('foreground'), fillClass('mutedForeground'), fillClass('subtle')]).toEqual(['t', 's', 'm'])
})

test('tokens: the names the non-SVG code uses are the dark values, and toneOf maps them back', () => {
  expect([ACCENT, DONE, BLOCKED, FAILED, MUTED]).toEqual([COLORS.primary.dark, COLORS.success.dark, COLORS.warning.dark, COLORS.destructive.dark, COLORS.mutedForeground.dark])
  expect([ACCENT, DONE, BLOCKED, FAILED, MUTED, undefined, 'tomato'].map(toneOf)).toEqual(['primary', 'success', 'warning', 'destructive', 'neutral', 'neutral', 'neutral'])
})

test('styleFor: a drawing carries only the classes it uses, both schemes, and the pulse only when something is live', () => {
  const still = styleFor(text(0, 10, 'a') + separator(0, 0, 10))
  expect(still).toContain(`.t{fill:${COLORS.foreground.light}}`)
  expect(still).toContain(`.t{fill:${COLORS.foreground.dark}}`)
  expect(still).toContain('.f-border{')
  expect(still).not.toContain('.f-primary{')
  expect(still).not.toContain('.live')
  expect(styleFor(dot(0, 0, 'primary', true))).toContain('.live{animation:')
  const framed = frame(100, 20, text(0, 10, 'a'))
  expect(framed.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20" viewBox="0 0 100 20"><style>')).toBe(true)
})

test('text: escaped, cut to maxW with an ellipsis, in its role, with its anchor', () => {
  expect(xml(`a<b>&"c"`)).toBe('a&lt;b&gt;&amp;&quot;c&quot;')
  expect(text(4, 10, '<Tag & "more">')).toContain('>&lt;Tag &amp; &quot;more&quot;&gt;<')
  const long = 'A title that will not fit in sixty pixels at all'
  const cut = />([^<]*)</.exec(text(0, 10, long, { maxW: 60 }))?.[1] ?? ''
  expect(cut.endsWith('…')).toBe(true)
  expect(textWidth(cut, 12)).toBeLessThanOrEqual(60)
  expect(fitText('short', 12, 200)).toBe('short')
  expect(text(0, 10, 'a')).toContain('class="t" x="0" y="10" font-size="12" font-weight="450"')
  expect(text(0, 10, 'a', { role: 'mutedForeground' })).toContain('class="s"')
  expect(text(0, 10, 'a', { role: 'subtle' })).toContain('class="m"')
  expect(text(0, 10, 'a', { role: 'neutral' })).toContain('class="s"')
  // Mono is a class: the stylesheet's rule for text would win over an attribute.
  expect(text(0, 10, 'a', { role: 'subtle', isMono: true })).toContain('class="m mono"')
  expect(styleFor(text(0, 10, 'a', { isMono: true }))).toContain('.mono{font-family:ui-monospace')
  expect(text(0, 10, 'a', { role: 'warning', anchor: 'end', isTabular: true })).toMatch(/class="f-warning".* text-anchor="end" font-variant-numeric="tabular-nums"/)
})

test('badge: its width is measured from the label, never under minW, and an end anchor ends it at x', () => {
  const short = badge(10, 0, 'Ready', { tone: 'success' })
  const long = badge(10, 0, 'Fix round 1 of 2', { tone: 'primary' })
  expect(short.width).toBe(Math.round(textWidth('Ready', 10) + 14))
  expect(long.width).toBeGreaterThan(short.width)
  expect(short.svg).toContain(`<rect x="10" y="0" width="${short.width}" height="${BADGE_H}"`)
  expect(short.svg).toContain('fill-opacity="0.14" class="f-success"')
  expect(short.svg).toMatch(/class="f-success"[^>]*>Ready</)
  expect(badge(0, 0, 'p1', { minW: 38 }).width).toBe(38)
  const ended = badge(200, 0, 'Blocked', { tone: 'warning', anchor: 'end' })
  expect(ended.svg).toContain(`<rect x="${200 - ended.width}" y="0"`)
  // An outline badge is the card with the border; a dot makes it wider and pulses when live.
  expect(badge(0, 0, 'p1', { variant: 'outline' }).svg).toContain('class="f-card k-border"')
  const live = badge(0, 0, 'Running', { tone: 'primary', dot: 'live' })
  expect(live.width).toBe(badge(0, 0, 'Running', { tone: 'primary' }).width + 9)
  expect(live.svg).toContain('class="live"')
  expect(badge(0, 0, 'Done', { tone: 'success', dot: 'still' }).svg).not.toContain('class="live"')
})

test('bars: progress clamps its value and draws no fill at zero; segments spread over the width with a stripe pattern for the striped one', () => {
  expect(progress(0, 0, 100, 0, 'primary')).not.toContain('f-primary')
  expect(progress(0, 0, 100, 0.5, 'primary')).toContain('width="50" height="6" rx="3" class="f-primary"')
  expect(progress(0, 0, 100, 7, 'success')).toContain('width="100" height="6" rx="3" class="f-success"')
  const bar = segments(0, 0, 100, [{ tone: 'success' }, { tone: 'primary', isStriped: true }, { tone: 'track' }], { gap: 5 })
  expect([...bar.matchAll(/<rect x="([\d.]+)" y="0" width="30"/g)].map(m => Number(m[1]))).toEqual([0, 35, 70])
  expect(bar).toContain(`<pattern id="${stripeId('primary')}"`)
  expect(bar).toContain(`fill="url(#${stripeId('primary')})"`)
  expect(bar).toContain('class="f-input"')
  // No segment at all: one empty track over the width.
  expect(segments(0, 0, 100, [])).toBe('<rect x="0" y="0" width="100" height="6" rx="3" class="f-input"/>')
})

test('dots, lines and icons: the pulse only when live, a hollow dot is a ring, every icon is a stroked 24-unit drawing scaled to its size', () => {
  expect(dot(5, 5, 'primary', true)).toBe('<g class="live"><circle cx="5" cy="5" r="3.5" class="f-primary"/></g>')
  expect(dot(5, 5, 'neutral')).toBe('<circle cx="5" cy="5" r="3.5" class="s"/>')
  expect(dot(5, 5, 'neutral', false, { isHollow: true })).toContain('fill="none" stroke-width="1.5" class="k-mutedForeground"')
  expect(separator(0, 9, 40)).toBe('<rect x="0" y="9" width="40" height="1" class="f-border"/>')
  expect(divider(3, 0, 12)).toBe('<rect x="3" y="0" width="1" height="12" class="f-border"/>')
  expect(surface(0, 0, 100, 50, { variant: 'primary' })).toBe('<rect x="0.5" y="0.5" width="99" height="49" rx="10" class="f-primarySurface k-primaryBorder"/>')
  expect(soft(0, 0, 28, 28, 'primary')).toContain('fill-opacity="0.14" class="f-primary"')
  expect(disc(12, 12, 11, 'plain')).toContain('class="f-card k-border"')
  expect(disc(12, 12, 11, 'success')).toContain('stroke-opacity="0.5" class="f-success k-success"')
  for (const name of ICON_NAMES) {
    const drawn = icon(name, 2, 3, 12, 'primary')
    expect(drawn).toContain('transform="translate(2 3) scale(0.5)" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="k-primary"')
    expect(drawn).toMatch(/<(path|circle|rect) /)
  }
  expect(check(20, 20)).toContain('translate(12 12)')
  expect(check(20, 20)).toContain('class="k-success"')
})

const ROW = (over: Partial<TaskRow>): TaskRow => ({ n: 1, kind: 'pending', eyebrow: '01 · PENDING', badge: 'Pending', badgeKind: 'pending', title: 'A task', history: [], ...over })
const BAND: Band = { id: 'p1', title: 'Export', state: 'BUILDING', color: BAND_COLORS.running, count: 'Task 1 / 2', segments: ['current', 'pending'], activity: 'Implementer · starting', clock: '0:10', summary: '', tasks: [] }

/** Every drawing of draw.ts, in each of its states. */
const drawings = (): string[] => [
  heroSvg(480, { kind: 'idle', state: 'PIPELINE IDLE', headline: 'Nothing running', line: 'A line.', chip: 'Ready to build', hint: '0 active agents' }).source,
  heroSvg(480, { kind: 'running', state: 'BUILDING · P1', headline: 'Export', line: 'A line.', progress: { done: 1, total: 2 }, steps: [{ name: 'Plan', state: 'done' }, { name: 'Build', state: 'current' }, { name: 'Review', state: 'pending' }, { name: 'Merge', state: 'pending' }] }).source,
  heroSvg(480, { kind: 'history', state: 'HISTORY', headline: '3 items merged', line: 'all time' }).source,
  metricsSvg(480, [{ value: 1, label: 'Inbox' }, { value: 2, label: 'Ready', color: ACCENT }, { value: 3, label: 'Merged', color: DONE }]),
  ...(['running', 'done', 'failed'] as const).map(status => agentCardSvg(480, { role: 'Implementer', model: 'claude-sonnet-5-5', status, activity: 'starting', progress: 0.4, calls: 1, tokens: 10, elapsedMs: 1000 })),
  ...(['running', 'done', 'blocked', 'ready', 'muted'] as const).map(kind => itemRowSvg(400, { id: 'p1', title: 'Export', meta: 'M', tag: { text: 'Tag', kind } })),
  mergedRowSvg(400, { id: 'p1', title: 'Export' }),
  sessionRowSvg(400, { title: 'A session', meta: 'p1 · 1 agent', isLive: true, isStale: false }),
  sessionRowSvg(400, { title: 'A session', meta: 'stale', isLive: true, isStale: true, isDim: true, isLast: true }),
  captionSvg(400, '1 agent working', '/pipeline status', true),
  taskBarSvg(400, ['accepted', 'current', 'blocked', 'pending']),
  taskRowSvg(400, ROW({ kind: 'done', badgeKind: 'done', badge: 'Accepted', sub: 'Implemented' }), { isFirst: true, isLast: false, isCompact: false }).source,
  taskRowSvg(400, ROW({ kind: 'current', badgeKind: 'running', badge: '● Running', agent: { role: 'Implementer', model: 'Sonnet 5.5', activity: 'starting', calls: 1, tokens: 10, elapsedMs: 1000 } }), { isFirst: false, isLast: false, isCompact: false }).source,
  taskRowSvg(400, ROW({ kind: 'current', badgeKind: 'running', badge: 'Fix round 1 of 2', lead: 'Lead · fix', history: [{ text: 'Build ✓', kind: 'done' }, { text: 'Review · FIX', kind: 'blocked' }, { text: 'Fix', kind: 'muted' }] }), { isFirst: false, isLast: false, isCompact: false }).source,
  taskRowSvg(400, ROW({ kind: 'blocked', badgeKind: 'blocked', badge: 'Blocked' }), { isFirst: false, isLast: false, isCompact: true }).source,
  taskRowSvg(400, ROW({}), { isFirst: false, isLast: true, isCompact: false }).source,
  bandSvg(BAND, 600),
  bandSvg({ ...BAND, state: 'BLOCKED', color: BAND_COLORS.blocked, segments: ['accepted', 'blocked'] }, 600),
  bandSvg({ ...BAND, state: 'MERGED', color: BAND_COLORS.merged }, 600),
  bandSvg({ ...BAND, state: 'READY', color: BAND_COLORS.idle }, 600),
  bandSvg(BAND, 600, true),
  idleStripSvg('pipeline · idle', 600),
]

test('no colour outside the tokens: every drawing paints by class, and the only hex colours are the tokens\' in its stylesheet', () => {
  for (const svg of drawings()) {
    // Nothing in the body names a colour: no hex, no fill or stroke attribute other than none or a pattern.
    expect(bodyOf(svg).match(HEX)).toBeNull()
    for (const m of bodyOf(svg).matchAll(/ (?:fill|stroke)="([^"]*)"/g)) expect(m[1] === 'none' || m[1]!.startsWith('url(#stripe-')).toBe(true)
    const style = styleOf(svg)
    for (const hex of style.match(HEX) ?? []) expect(ALL_COLORS).toContain(hex)
    // Each class the body uses is defined, in both schemes.
    const used = new Set([...bodyOf(svg).matchAll(/class="([^"]*)"/g)].flatMap(m => (m[1] ?? '').split(' ')))
    for (const cls of used) expect(style.split(`.${cls}{`).length).toBeGreaterThanOrEqual(cls === 'live' || cls === 'mono' ? 2 : 3)
    expect(style).toContain('prefers-color-scheme: dark')
  }
})

test('one look: every card has the same radius, every badge the same shape, and each tone is offered by the badge', () => {
  const all = drawings().map(bodyOf).join('')
  // The cards (hero, tiles, agent card, the current task's card, the band) are bordered surfaces of radius 10 or, nested, 8.
  const radii = new Set([...all.matchAll(/rx="(\d+)" class="f-(?:card|muted|primarySurface) k-/g)].map(m => m[1]))
  expect([...radii].sort()).toEqual(['10', '6', '8'])
  // Every soft badge is BADGE_H tall with radius 6.
  for (const m of all.matchAll(/height="(\d+)" rx="6" fill-opacity="0.14"/g)) expect(Number(m[1])).toBe(BADGE_H)
  for (const tone of TONES) expect(badge(0, 0, tone, { tone }).svg).toContain(tone === 'neutral' ? 'class="s"' : `class="f-${tone}"`)
})
