// The panel's views, drawn from plain data with the surface's own elements.
// One tree for terminal and desktop: Box, Text and Button only.
import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRun, Board, Item, Live, Milestone, NativeTask } from '../types'
import { attention, elapsed, queueText, shortModel } from './board'
import type { Others } from './live'

export type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Element = RenderElement
// The surface's elements as plain components: the tables differ per surface, the props used here do not.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Comp = (p: Record<string, any>) => Element

export const RUNNING = '#8f8cf4'
export const DONE = '#5fbf8f'
export const BLOCKED = '#e8a33c'

export const FINISHED_SHOWN = 8

/** What the Now view keeps when it is drawn inside a milestone. */
export type NowFilter = { id: string; titles: string[] }

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export function renderNow(ui: Ui, d: { agents: AgentRun[]; tasks: NativeTask[]; others: Others; at: number; filter?: NowFilter }): Element {
  const { Box, Text } = ui as unknown as { Box: Comp; Text: Comp }
  const f = d.filter
  const agents = f ? d.agents.filter(a => f.titles.some(t => t && a.name.includes(t))) : d.agents
  const others = f ? d.others.filter(o => o.item?.startsWith(`${f.id}/`)) : d.others
  const tasks = f ? [] : [...d.tasks].sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress'))
  const running = agents.filter(a => a.status === 'running')
  const finished = agents.filter(a => a.status !== 'running')
  const shown = finished.slice(-FINISHED_SHOWN).reverse()
  const head = (text: string) => <Text dimColor>{text}</Text>

  if (!tasks.length && !agents.length && !others.length) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{f ? 'Nothing running on this milestone.' : 'Nothing running. /board status prints this as text.'}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {tasks.length > 0 && head('Tasks')}
      {tasks.map(t => (
        <Box flexDirection="row">
          <Text color={t.status === 'in_progress' ? RUNNING : t.status === 'completed' ? DONE : undefined} dimColor={t.status === 'pending'}>
            {t.status === 'in_progress' ? '●' : t.status === 'completed' ? '✓' : '○'}
          </Text>
          <Text wrap="truncate-end" dimColor={t.status === 'completed'}>
            {` ${t.subject}`}
          </Text>
        </Box>
      ))}
      {agents.length > 0 && head(`Agents · ${running.length} running`)}
      {running.map(a => (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text color={RUNNING}>●</Text>
            <Text wrap="truncate-end">{` ${a.name}`}</Text>
            <Text dimColor>{` ${shortModel(a.model)} · ${elapsed(d.at - a.startedAt)}`}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{`  ▶ ${a.activity}`}</Text>
        </Box>
      ))}
      {shown.map(a => (
        <Box flexDirection="row">
          <Text color={a.status === 'done' ? DONE : BLOCKED}>{a.status === 'done' ? '✓' : '✗'}</Text>
          <Text dimColor wrap="truncate-end">{` ${a.name}`}</Text>
          <Text dimColor>{` ${elapsed((a.endedAt ?? d.at) - a.startedAt)} · ${plural(a.calls, 'call')}`}</Text>
        </Box>
      ))}
      {finished.length > FINISHED_SHOWN && <Text dimColor>{`+${finished.length - FINISHED_SHOWN} · /board status`}</Text>}
      {others.length > 0 && head('Sessions')}
      {others.map(o => {
        const latest = o.agents[o.agents.length - 1]
        const sub = [o.branch, o.item, o.agents.length ? plural(o.agents.length, 'agent') : '', latest?.activity, o.isQuiet ? 'quiet' : ''].filter(Boolean).join(' · ')
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text color={o.isQuiet ? undefined : RUNNING} dimColor={o.isQuiet}>
                {o.isQuiet ? '◌' : '●'}
              </Text>
              <Text wrap="truncate-end">{` ${o.title}`}</Text>
            </Box>
            {sub && <Text dimColor wrap="truncate-end">{`  ${sub}`}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}

// ---------- the board ----------

export const PLANNED_SHOWN = 4

export function barText(done: number, total: number, width = 20): string {
  const filled = total > 0 ? Math.round((Math.min(done, total) / total) * width) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const doneOf = (m: Milestone) => m.items.filter(i => i.status === 'done').length
const MILESTONE_GLYPH: Record<string, string> = { active: '●', planned: '○', done: '✓' }

type Els = { Box: Comp; Text: Comp; Button: Comp }

export function renderHome(
  ui: Ui,
  d: {
    board: Board | null
    error: string | null
    live: Live
    agents: AgentRun[]
    tasks: NativeTask[]
    others: Others
    at: number
    isMoreShown: boolean
    onOpen: (id: string) => void
    onNow: () => void
    onMore: () => void
  },
): Element {
  const { Box, Text, Button } = ui as unknown as Els
  const head = (text: string) => <Text dimColor>{text}</Text>
  const nowButton = (
    <Button
      key="now"
      plain
      label={`Now · ${plural(d.agents.filter(a => a.status === 'running').length, 'agent')} · ${plural(d.tasks.length, 'task')} · ${plural(d.others.length, 'session')}`}
      onPress={d.onNow}
    />
  )
  if (d.error || !d.board) {
    return (
      <Box flexDirection="column">
        {d.error ? <Text color={BLOCKED}>{`Board: ${d.error}`}</Text> : <Text dimColor>No board. /board init reads the plans and the ledger.</Text>}
        {nowButton}
      </Box>
    )
  }
  const b = d.board
  const items = b.milestones.flatMap(m => m.items)
  const done = items.filter(i => i.status === 'done').length
  const [num, den] = b.goal ? [b.goal.done, b.goal.total] : [done, items.length]
  const group = (s: Milestone['status']) => b.milestones.filter(m => m.status === s)
  const row = (m: Milestone) => (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Button key={`m-${m.id}`} plain label={`${MILESTONE_GLYPH[m.status] ?? '○'} ${m.title} · ${doneOf(m)}/${m.items.length}`} onPress={() => d.onOpen(m.id)} />
        {m.status === 'planned' && queueText(m) && <Text dimColor>{`  ${queueText(m)}`}</Text>}
      </Box>
      {m.status === 'active' &&
        (() => {
          const a = attention(m, d.live, d.at)
          if (a.kind === 'none') return null
          return (
            <Text color={a.kind === 'blocked' ? BLOCKED : a.kind === 'in_progress' ? RUNNING : undefined} dimColor={a.kind === 'next'} wrap="truncate-end">
              {`  ${a.text}`}
            </Text>
          )
        })()}
    </Box>
  )
  const active = group('active')
  const planned = group('planned')
  const finished = group('done')
  const shownPlanned = d.isMoreShown ? planned : planned.slice(0, PLANNED_SHOWN)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold>Board</Text>
        <Text dimColor>{b.goal ? ` · ${b.goal.title} ${num}/${den}` : ` · ${num}/${den} items`}</Text>
      </Box>
      <Text color={DONE}>{barText(num, den)}</Text>
      {active.length > 0 && head('Active')}
      {active.map(row)}
      {planned.length > 0 && head('Planned')}
      {shownPlanned.map(row)}
      {planned.length > PLANNED_SHOWN && (
        <Button key="more" plain label={d.isMoreShown ? 'Show fewer' : `… and ${planned.length - PLANNED_SHOWN} more planned`} onPress={d.onMore} />
      )}
      {finished.length > 0 && head('Done')}
      {finished.length === 1 ? finished.map(row) : finished.length > 1 && <Text dimColor>{`✓ ${finished.length} done, latest: ${finished[finished.length - 1]!.title}`}</Text>}
      {nowButton}
    </Box>
  )
}

const RANGE = /\b[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\b/

const ITEM_GROUPS: Array<{ status: Item['status']; title: string; glyph: string; color?: string }> = [
  { status: 'in_progress', title: 'In progress', glyph: '●', color: RUNNING },
  { status: 'blocked', title: 'Blocked', glyph: '◐', color: BLOCKED },
  { status: 'next', title: 'Next', glyph: '○' },
  { status: 'backlog', title: 'Backlog', glyph: '·' },
  { status: 'done', title: 'Done', glyph: '✓', color: DONE },
]

export function renderMilestone(
  ui: Ui,
  d: { m: Milestone; board: Board; live: Live; agents: AgentRun[]; tasks: NativeTask[]; others: Others; at: number; onBack: () => void },
): Element {
  const { Box, Text, Button } = ui as unknown as Els
  const m = d.m
  const where = [m.ref, m.branch].filter(Boolean).join(' · ')
  const holderOf = (i: Item) => d.others.find(o => o.item === `${m.id}/${i.id}`)?.title
  const since = (iso: string | undefined) => {
    const t = iso ? Date.parse(iso) : NaN
    return Number.isNaN(t) ? '' : elapsed(d.at - t)
  }
  const right = (i: Item) => (i.status === 'in_progress' || i.status === 'blocked' ? since(i.updatedAt) : i.status === 'done' ? (RANGE.exec(i.note ?? '')?.[0] ?? '') : '')
  return (
    <Box flexDirection="column">
      <Button key="back" plain label="‹ Board" onPress={d.onBack} />
      <Text bold wrap="truncate-end">{`${m.title} · ${doneOf(m)}/${m.items.length}`}</Text>
      <Text color={DONE}>{barText(doneOf(m), m.items.length)}</Text>
      {where && <Text dimColor wrap="truncate-end">{where}</Text>}
      {ITEM_GROUPS.map(g => {
        const list = m.items.filter(i => i.status === g.status)
        if (!list.length) return null
        return (
          <Box flexDirection="column">
            <Text dimColor>{g.title}</Text>
            {list.map(i => {
              const holder = holderOf(i)
              const r = right(i)
              const note = i.note && i.note !== r ? i.note : ''
              return (
                <Box flexDirection="column">
                  <Box flexDirection="row">
                    <Text color={g.color} dimColor={!g.color}>
                      {g.glyph}
                    </Text>
                    <Text wrap="truncate-end" dimColor={i.status === 'done'}>{` ${i.title}${holder ? ` · ${holder}` : ''}`}</Text>
                    {r && <Text dimColor>{`  `}</Text>}
                    {r && <Text dimColor>{r}</Text>}
                  </Box>
                  {note && <Text dimColor wrap="truncate-end">{`  ${note}`}</Text>}
                </Box>
              )
            })}
          </Box>
        )
      })}
      {(m.closes?.length ?? 0) > 0 && <Text dimColor>Rows this milestone closes</Text>}
      {(m.closes ?? []).map(c => (
        <Text dimColor wrap="truncate-end">{`  ${c}`}</Text>
      ))}
      <Text dimColor>Now</Text>
      {renderNow(ui, { agents: d.agents, tasks: d.tasks, others: d.others, at: d.at, filter: { id: m.id, titles: m.items.map(i => i.title) } })}
    </Box>
  )
}
