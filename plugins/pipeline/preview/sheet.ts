// The kit sheet: every primitive of hooks/ui/kit.ts and every drawing of hooks/draw.ts on one page, each tone and
// state, so the look is checked in one place and a new section is compared against it. Shot in both colour schemes.

import { TAB_UNDERLINE_H, separatorSvg, tabUnderlineSvg, tabWidth } from '../hooks/draw'
import { Box, Button, Svg, htmlOf } from './html'
import { AGENT_CARD_H, BAND_COMPACT_H, BAND_H, CAPTION_H, MERGED_ROW_H, METRICS_H, ROW_H, SESSION_ROW_H, TASK_BAR_H, agentCardSvg, bandSvg, captionSvg, heroSvg, idleStripSvg, itemRowSvg, mergedRowSvg, metricsSvg, sessionRowSvg, taskBarSvg, taskRowSvg } from '../hooks/draw'
import type { Band, TagKind, TaskRow } from '../hooks/status'
import { BAND_COLORS } from '../hooks/status'
import { BADGE_H, ICON_NAMES, badge, check, disc, divider, dot, frame, icon, progress, segments, separator, soft, surface, text } from '../hooks/ui/kit'
import type { Role } from '../hooks/ui/tokens'
import { DONE, RADIUS, SIZE, TONES, WEIGHT } from '../hooks/ui/tokens'

const label = (s: string): string => `<p class="label">${s}</p>`
const block = (W: number, H: number, source: string): string => `<div class="svg" style="width:${W}px;height:${H}px">${source}</div>`
const drawn = (W: number, H: number, body: string): string => block(W, H, frame(W, H, body))

const TEXT_ROLES: Role[] = ['foreground', 'mutedForeground', 'subtle', 'primary', 'success', 'warning', 'destructive']

const task = (over: Partial<TaskRow> & Pick<TaskRow, 'n' | 'kind' | 'eyebrow' | 'badge' | 'badgeKind' | 'title'>): TaskRow => ({ history: [], ...over })

const band = (over: Partial<Band>): Band => ({ id: 'p72', title: 'Grid track interaction', state: 'BUILDING', color: BAND_COLORS.running, count: 'Task 2 / 3', segments: ['accepted', 'current', 'pending'], activity: 'Implementer · Opus 5.5 · running npx prettier', clock: '2:36', summary: '', tasks: [], ...over })

export const kitSheet = (W: number): string => {
  const out: string[] = []

  out.push(label('Type · five sizes, three greys, four tones'))
  const sizes = Object.entries(SIZE)
  out.push(
    drawn(
      W,
      sizes.length * 24 + 4,
      sizes
        .map(([name, size], i) => text(0, 18 + i * 24, `${name} ${size}`, { size, role: 'subtle' }) + text(64, 18 + i * 24, 'Grid track interaction', { size, weight: WEIGHT.regular }) + text(260, 18 + i * 24, 'medium', { size, weight: WEIGHT.medium }) + text(340, 18 + i * 24, 'semibold', { size, weight: WEIGHT.semibold }))
        .join(''),
    ),
  )
  out.push(drawn(W, 22, TEXT_ROLES.map((role, i) => text(i * 74, 15, role === 'mutedForeground' ? 'muted' : role, { size: SIZE.sm, weight: WEIGHT.medium, role })).join('')))

  out.push(label('Surfaces · card, muted, primary · radius lg, md'))
  const sw = (W - 16) / 3
  out.push(
    drawn(
      W,
      56,
      (['card', 'muted', 'primary'] as const).map((variant, i) => surface(i * (sw + 8), 0, sw, 56, { variant }) + text(i * (sw + 8) + 12, 24, variant, { weight: WEIGHT.medium }) + text(i * (sw + 8) + 12, 41, 'surface', { size: SIZE.sm, role: 'subtle' })).join(''),
    ),
  )
  out.push(drawn(W, 32, surface(0, 0, sw, 32, { radius: RADIUS.md }) + text(12, 20, 'nested · radius md', { size: SIZE.sm, role: 'mutedForeground' }) + soft(sw + 8, 2, 28, 28, 'primary') + icon('bot', sw + 14, 8, 16, 'primary') + separator(sw + 48, 16, 120) + divider(sw + 180, 10, 12)))

  out.push(label('Badges · soft, outline, with a dot'))
  let x = 0
  const softRow = TONES.map(tone => {
    const b = badge(x, 0, tone, { tone })
    x += b.width + 8
    return b.svg
  }).join('')
  x = 0
  const outlineRow = TONES.map(tone => {
    const b = badge(x, 26, tone, { tone, variant: 'outline' })
    x += b.width + 8
    return b.svg
  }).join('')
  x = 0
  const dotRow = TONES.map(tone => {
    const b = badge(x, 52, tone === 'primary' ? 'Running' : tone, { tone, dot: tone === 'primary' ? 'live' : 'still' })
    x += b.width + 8
    return b.svg
  }).join('')
  out.push(drawn(W, 52 + BADGE_H, softRow + outlineRow + dotRow + badge(W, 0, 'BUILDING', { tone: 'primary', anchor: 'end', tracking: 0.5 }).svg + badge(W, 26, 'p39', { tone: 'primary', variant: 'outline', anchor: 'end', minW: 38 }).svg))

  out.push(label('Dots, discs, checks'))
  out.push(
    drawn(
      W,
      26,
      TONES.map((tone, i) => dot(6 + i * 18, 13, tone, tone === 'primary')).join('') +
        dot(6 + TONES.length * 18, 13, 'neutral', false, { isHollow: true }) +
        TONES.map((tone, i) => disc(140 + i * 30, 13, 11.5, tone, tone === 'primary' || tone === 'warning')).join('') +
        disc(140 + TONES.length * 30, 13, 11.5, 'plain') +
        TONES.map((tone, i) => check(340 + i * 22, 13, tone)).join(''),
    ),
  )

  out.push(label('Icons · Lucide, 16 px and 12 px'))
  out.push(drawn(W, 40, ICON_NAMES.map((name, i) => icon(name, i * 28, 0, 16, 'foreground') + icon(name, i * 28 + 2, 24, 12, i % 2 ? 'primary' : 'mutedForeground')).join('')))

  out.push(label('Bars · progress per tone, segments'))
  out.push(drawn(W, TONES.length * 12, TONES.map((tone, i) => progress(0, i * 12, W, 0.2 + i * 0.18, tone)).join('')))
  out.push(drawn(W, 6, segments(0, 0, W, [{ tone: 'success' }, { tone: 'primary', isStriped: true }, { tone: 'warning' }, { tone: 'destructive' }, { tone: 'track' }])))
  out.push(block(W, TASK_BAR_H, taskBarSvg(W, ['accepted', 'accepted', 'current', 'blocked', 'pending'])))

  out.push(label('Tabs · a Button over its underline, one hairline under the row'))
  const tabs = ['Overview', 'Queue · 38', 'History']
  out.push(
    htmlOf(
      Box({
        flexDirection: 'column',
        children: [
          Box({
            flexDirection: 'row',
            gap: 2,
            children: tabs.map((t, i) => Box({ flexDirection: 'column', alignItems: 'flex-start', children: [Button({ plain: true, dimColor: i !== 0, label: t }), Svg({ source: tabUnderlineSvg(tabWidth(t), i === 0), alt: '', width: tabWidth(t), height: TAB_UNDERLINE_H })] })),
          }),
          Svg({ source: separatorSvg(W), alt: '', width: W, height: 1 }),
        ],
      }),
    ),
  )

  out.push(label('Hero · idle, running, history'))
  for (const hero of [
    heroSvg(W, { kind: 'idle', state: 'PIPELINE IDLE', headline: 'Nothing running right now', line: 'There are 27 items in your inbox and 1 is ready to build. Run /pipeline next to start the first.', chip: 'Ready to build', hint: '0 active agents' }),
    heroSvg(W, {
      kind: 'running',
      state: 'BUILDING · P72',
      headline: 'Grid track interaction',
      line: 'Resizable grid tracks on the canvas: drag a boundary, the Page tab follows live.',
      progress: { done: 1, total: 3 },
      steps: [
        { name: 'Plan', state: 'done' },
        { name: 'Build', state: 'current' },
        { name: 'Review', state: 'pending' },
        { name: 'Merge', state: 'pending' },
      ],
    }),
    heroSvg(W, { kind: 'history', state: 'HISTORY', headline: '33 items merged', line: 'all time · 5 this week' }),
  ])
    out.push(block(W, hero.height, hero.source))

  out.push(label('Metric tiles'))
  out.push(
    block(
      W,
      METRICS_H,
      metricsSvg(W, [
        { value: 0, label: 'Active' },
        { value: 1, label: 'Ready' },
        { value: 27, label: 'Inbox' },
        { value: 5, label: 'Merged', color: DONE },
      ]),
    ),
  )

  out.push(label('Caption'))
  out.push(block(W, CAPTION_H, captionSvg(W, '9:00 elapsed · 2.2M tokens · ≈$1.29 cost')))
  out.push(block(W, CAPTION_H, captionSvg(W, '1 agent working · no signals', '/pipeline status', true)))

  out.push(label('Agent card · running, done, failed'))
  for (const status of ['running', 'done', 'failed'] as const) out.push(block(W, AGENT_CARD_H, agentCardSvg(W, { role: 'Implementer', model: 'claude-opus-5-5', effort: 'medium', status, activity: 'running npx prettier --check .', progress: status === 'running' ? 0.35 : 1, calls: 18, tokens: 1_400_000, elapsedMs: 156_000 })))

  out.push(label('Item rows · every tag'))
  const tags: [string, TagKind, string][] = [
    ['Building', 'running', 'p72'],
    ['Ready', 'ready', 'p39'],
    ['No spec', 'blocked', 'p40'],
    ['Merged', 'done', 'p33'],
    ['Parked', 'muted', 'p101'],
  ]
  tags.forEach(([word, kind, id], i) => out.push(block(W, ROW_H, itemRowSvg(W, { id, title: i === 2 ? 'Empty grid areas refilled after a card resize, with a title long enough to be cut at this width' : 'Grid row and column sizes', meta: 'M · Inbox', tag: { text: word, kind }, isLast: i === tags.length - 1 }))))

  out.push(label('Merged rows'))
  out.push(block(W, MERGED_ROW_H, mergedRowSvg(W, { id: 'p33', title: 'Slot styles and image fit' })))
  out.push(block(W, MERGED_ROW_H, mergedRowSvg(W, { id: 'p32', title: 'Page document v2: four margins', isLast: true })))

  out.push(label('Session rows · live, idle, stale'))
  out.push(block(W, SESSION_ROW_H, sessionRowSvg(W, { title: 'p12 · App themes per user', meta: 'p12 · 2 agents', isLive: true, isStale: false })))
  out.push(block(W, SESSION_ROW_H, sessionRowSvg(W, { title: 'catalo', meta: 'idle', isLive: false, isStale: false, isDim: true })))
  out.push(block(W, SESSION_ROW_H, sessionRowSvg(W, { title: 'p14 · Export', meta: 'p14 · stale', isLive: true, isStale: true, isLast: true })))

  out.push(label('Task rows · done, current with an agent, current in a fix round, blocked, pending'))
  const rows: TaskRow[] = [
    task({ n: 1, kind: 'done', eyebrow: '01 · COMPLETED', badge: 'Accepted', badgeKind: 'done', title: 'Grid line model and track-resize gesture', sub: 'Implemented by Opus 5.5 · 4m 34s · review skipped (taskReview off)' }),
    task({ n: 2, kind: 'current', eyebrow: '02 · CURRENT TASK', badge: '● Running', badgeKind: 'running', title: 'Canvas: drawn grid, draggable boundaries, keyboard and double-click', sub: 'Implementation · in progress', agent: { role: 'Implementer', model: 'Opus 5.5 · medium', activity: 'running npx prettier', calls: 18, tokens: 1_400_000, elapsedMs: 156_000 } }),
    task({
      n: 3,
      kind: 'current',
      eyebrow: '03 · CURRENT TASK',
      badge: 'Fix round 1 of 2',
      badgeKind: 'running',
      title: 'The Page tab follows the drag live, in both editors',
      sub: 'Fix round 1 of 2 · after review: FIX REQUIRED',
      lead: 'Lead · fix round 1 dispatched · 0:40',
      history: [
        { text: 'Build · Sonnet 5.5 · 3:20 ✓', kind: 'done' },
        { text: 'Review · Opus 5.5 · 0:58 · FIX REQUIRED', kind: 'blocked' },
        { text: 'Fix 1 of 2 · Sonnet 5.5 · running', kind: 'muted' },
      ],
    }),
    task({ n: 4, kind: 'blocked', eyebrow: '04 · BLOCKED', badge: 'Blocked', badgeKind: 'blocked', title: 'Keyboard step honours the minimum track size', sub: 'Blocked · lint failed twice' }),
    task({ n: 5, kind: 'pending', eyebrow: '05 · PENDING', badge: 'Pending', badgeKind: 'pending', title: 'Documentation of the gesture' }),
  ]
  rows.forEach((r, i) => {
    const d = taskRowSvg(W, r, { isFirst: i === 0, isLast: i === rows.length - 1, isCompact: false })
    out.push(`<div class="svg" style="width:${W}px;height:${d.height}px;margin:0">${d.source}</div>`)
  })

  out.push(label('Band · running, review, blocked, merged, ready, narrow, compact, idle strip'))
  const BW = 456
  out.push(block(BW, BAND_H, bandSvg(band({}), BW)))
  out.push(block(BW, BAND_H, bandSvg(band({ state: 'REVIEW', count: '3 / 3 accepted', segments: ['accepted', 'accepted', 'accepted'], activity: 'Final review · Opus 5.5 · reading the diff', clock: '0:48' }), BW)))
  out.push(block(BW, BAND_H, bandSvg(band({ state: 'BLOCKED', color: BAND_COLORS.blocked, segments: ['accepted', 'blocked', 'pending'], activity: 'CI red twice', clock: '—' }), BW)))
  out.push(block(BW, BAND_H, bandSvg(band({ state: 'MERGED', color: BAND_COLORS.merged, count: '3 / 3 accepted', segments: ['accepted', 'accepted', 'accepted'], activity: 'Merged · #35', clock: '—' }), BW)))
  out.push(block(BW, BAND_H, bandSvg(band({ state: 'READY', color: BAND_COLORS.idle, count: '3 tasks', segments: ['pending', 'pending', 'pending'], activity: 'Next in queue · waiting to start', clock: '—' }), BW)))
  out.push(block(240, BAND_H, bandSvg(band({}), 240)))
  out.push(block(BW, BAND_COMPACT_H, bandSvg(band({}), BW, true)))
  out.push(block(BW, BAND_COMPACT_H, idleStripSvg('pipeline · idle · 27 inbox · next: p39 Grid row and column sizes', BW)))

  return out.join('')
}
