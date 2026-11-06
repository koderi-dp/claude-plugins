// The panel: the status block of spec §9 as a pane, drawn from the same data as the text.
// The desktop gets the agents panel of savvy-flow (a dotted grid, an SVG header, one card
// per run, plan rows) with the queue below; every other surface gets the text block.
// Nothing is only in the panel.
import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRun, Item, ItemStatus, Signal } from '../types'
import { ACCENT, BLOCKED, DONE, LINE_H, PLAN_H, ROWS_DONE, ROWS_DONE_MORE, ROWS_PLANNED, ROW_H, agentSvg, compactSvg, gridSvg, gridTiles, headerHeight, headerSvg, modelName, plannedSvg, summaryOf, totals } from './draw'
import type { PlanRow } from './draw'
import type { StatusInput } from './status'
import { taskCounter } from './status'

export type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Element = RenderElement
// The surface's elements as plain components: the tables differ per surface, the props used here do not.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Comp = (p: Record<string, any>) => Element

export { ACCENT as RUNNING, BLOCKED, DONE }

/** Rows a queue section shows before the Show more button. */
export const ROWS_SHOWN = 8

const ACTIVE: ItemStatus[] = ['planning', 'building', 'review']
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const FINISHED_SHOWN = 3

export type PanelInput = StatusInput & {
  surface: string
  /** Whether the surface's table has an Svg element. */
  hasSvg: boolean
  bodyColumns: number
  isMoreShown: boolean
  isCompact: boolean
  isDoneCollapsed: boolean
  /** The task-minutes limit, for a running card's bar. */
  limitMs: number
  onMore: () => void
  onCompact: () => void
  onDone: () => void
}

const minutes = (from: number, to: number) => Math.max(0, Math.round((to - from) / 60000))
const line = (parts: unknown[]) => parts.filter(p => p !== undefined && p !== null && p !== '').join(' · ')
const itemText = (item: Item, extra?: string) => line([item.id, item.title, item.size, extra])
const signalText = (s: Signal) => `${s.kind}: ${line([s.agent, s.detail])}`

/** The active item's line for the header and the band: `p12 · Export · task 3/6`. */
export function activeTitle(d: Pick<StatusInput, 'backlog' | 'ledger'>): string {
  const active = d.backlog?.items.find(i => ACTIVE.includes(i.status))
  if (!active) return ''
  const own = d.ledger && d.ledger.item === active.id ? d.ledger : null
  return line([active.id, active.title, taskCounter(own)])
}

/** The ledger's tasks that have not been accepted: what is still to run. */
export const plannedOf = (d: Pick<StatusInput, 'ledger'>): PlanRow[] =>
  (d.ledger?.tasks ?? []).filter(t => t.status === 'pending' || t.status === 'fix' || t.status === 'blocked').map(t => ({ n: t.n, title: t.title, status: t.status }))

/** The panel's tree for the surface at hand. */
export function renderPanel(ui: Ui, d: PanelInput): Element {
  return d.surface === 'desktop' && d.hasSvg ? renderDesktop(ui, d) : renderText(ui, d)
}

/** The text block: the head line, the active item, agents, signals, then the queues, each folded past eight rows. */
export function renderText(ui: Ui, d: PanelInput): Element {
  const { Box, Text, Button } = ui as unknown as { Box: Comp; Text: Comp; Button: Comp }
  const { config, backlog, readiness, ledger, agents, signals, now, fileError } = d
  const rows: Element[] = []
  const { section, hidden } = sections(Text, rows, d.isMoreShown)

  if (fileError) rows.push(<Text color={BLOCKED}>{`pipeline: ${fileError}`}</Text>)
  if (!config && !fileError) rows.push(<Text dimColor>pipeline: no config (run /pipeline init)</Text>)
  const items = backlog?.items ?? []
  if (backlog) {
    const ready = items.filter(i => i.status === 'ready')
    if (!fileError) rows.push(<Text bold>{`pipeline: ${items.length} item${items.length === 1 ? '' : 's'} · ${ready.length} ready`}</Text>)
    const active = items.filter(i => ACTIVE.includes(i.status))
    section(
      'Active',
      active.map(i => {
        const own = ledger && ledger.item === i.id ? ledger : null
        return <Text color={ACCENT}>{itemText(i, line([i.status, taskCounter(own), own?.resume?.state]))}</Text>
      }),
    )
  } else if (config && !fileError) rows.push(<Text dimColor>pipeline: no backlog (run /pipeline init)</Text>)

  rows.push(...agentRows(Text, agents, now))
  const open = signals.filter(s => !s.delivered)
  if (open.length) {
    rows.push(<Text dimColor>Signals</Text>)
    for (const s of open) rows.push(<Text color={BLOCKED} bold>{signalText(s)}</Text>)
  }
  if (backlog) rows.push(...queueRows(Text, d, section))

  if (hidden() > 0 || d.isMoreShown) {
    rows.push(<Button key="more" plain label={d.isMoreShown ? 'Show fewer' : `Show more (${hidden()} hidden)`} onPress={d.onMore} />)
  }
  if (!rows.length) rows.push(<Text dimColor>Nothing to show. /pipeline status prints this as text.</Text>)
  return <Box flexDirection="column">{rows}</Box>
}

/** A section helper: its heading, then its rows, folded past ROWS_SHOWN unless more is shown; counts what it hid. */
function sections(Text: Comp, rows: Element[], isMoreShown: boolean) {
  let hidden = 0
  const section = (title: string, list: Element[]) => {
    if (!list.length) return
    rows.push(<Text dimColor>{title}</Text>)
    const shown = isMoreShown ? list : list.slice(0, ROWS_SHOWN)
    hidden += list.length - shown.length
    rows.push(...shown)
  }
  return { section, hidden: () => hidden }
}

/** The queue sections: Ready, Blocked, Inbox, Parked, Merged this week. */
function queueRows(Text: Comp, d: PanelInput, section: (title: string, list: Element[]) => void): Element[] {
  const rows: Element[] = []
  const items = d.backlog?.items ?? []
  section(
    'Ready',
    items.filter(i => i.status === 'ready').map(i => <Text>{itemText(i, (i.needs ?? []).length ? `needs ${i.needs!.join(' ')}` : undefined)}</Text>),
  )
  section(
    'Blocked',
    items.filter(i => i.status === 'blocked').map(i => <Text color={BLOCKED}>{itemText(i, i.note || 'no reason recorded')}</Text>),
  )
  section(
    'Inbox',
    items
      .filter(i => i.status === 'inbox')
      .map(i => {
        const r = d.readiness[i.id]
        return (
          <Text>
            {itemText(i)}
            {r && !r.ready ? <Text dimColor>{` · ${r.reason}`}</Text> : null}
          </Text>
        )
      }),
  )
  const parked = items.filter(i => i.status === 'parked')
  if (parked.length) rows.push(<Text dimColor>{`Parked: ${parked.map(i => i.id).join(', ')}`}</Text>)
  section(
    'Merged this week',
    items.filter(i => i.status === 'merged' && i.updatedAt && d.now - Date.parse(i.updatedAt) <= WEEK_MS).map(i => <Text color={DONE}>{itemText(i, i.pr ?? undefined)}</Text>),
  )
  return rows
}

/** Running agents coloured, then the last few finished: failed in the blocked colour, done in the done colour. */
function agentRows(Text: Comp, agents: AgentRun[], now: number): Element[] {
  const running = agents.filter(a => a.status === 'running')
  const finished = agents.filter(a => a.status !== 'running').slice(-FINISHED_SHOWN).reverse()
  if (!running.length && !finished.length) return []
  const rows: Element[] = [<Text dimColor>Agents</Text>]
  for (const a of running) rows.push(<Text color={ACCENT}>{line([a.name, a.model, `${minutes(a.startedAt, now)} min`, a.activity])}</Text>)
  for (const a of finished) {
    const spent = minutes(a.startedAt, a.endedAt ?? now)
    rows.push(<Text color={a.status === 'failed' ? BLOCKED : DONE}>{line([a.name, a.model, `${spent} min`, a.status])}</Text>)
  }
  return rows
}

/** The desktop: the grid, the header, the toggle, signals, Running, Finished, Planned as drawings, then the queue as text. */
function renderDesktop(ui: Ui, d: PanelInput): Element {
  const { Box, Text, Button, Svg } = ui as unknown as { Box: Comp; Text: Comp; Button: Comp; Svg: Comp }
  const at = Math.max(d.now, ...d.agents.map(a => a.startedAt), 0)
  const running = d.agents.filter(a => a.status === 'running').reverse()
  const finished = d.agents.filter(a => a.status !== 'running').reverse()
  const planned = plannedOf(d)
  const t = totals(d.agents, at)
  const summary = summaryOf(t)
  const title = activeTitle(d)
  const W = Math.max(240, Math.min(900, (d.bodyColumns || 40) * 8 - 8))
  const toggleCompact = <Button key="compact" label={d.isCompact ? 'Expand' : 'Collapse'} plain onPress={d.onCompact} />

  if (d.isCompact) {
    return (
      <Box flexDirection="column" gap={1}>
        <Svg source={compactSvg(W, d.agents, planned, t)} alt={`${d.agents.length} agents, ${summary}`} width={W} height={32} />
        {toggleCompact}
      </Box>
    )
  }

  const doneRows = d.isDoneCollapsed ? [] : finished.slice(0, d.isMoreShown ? ROWS_DONE_MORE : ROWS_DONE)
  const planRows = planned.slice(0, ROWS_PLANNED)
  const doneHidden = d.isDoneCollapsed ? 0 : finished.length - doneRows.length
  const planHidden = planned.length - planRows.length
  const canMore = !d.isDoneCollapsed && !d.isMoreShown && finished.length > ROWS_DONE
  const canFewer = !d.isDoneCollapsed && d.isMoreShown && finished.length > ROWS_DONE
  const open = d.signals.filter(s => !s.delivered)
  const isEmpty = d.agents.length === 0 && planned.length === 0

  const queue: Element[] = []
  const { section } = sections(Text, queue, true)
  if (d.fileError) queue.push(<Text color={BLOCKED}>{`pipeline: ${d.fileError}`}</Text>)
  if (!d.config && !d.fileError) queue.push(<Text dimColor>pipeline: no config (run /pipeline init)</Text>)
  if (d.backlog) queue.push(...queueRows(Text, { ...d, isMoreShown: true }, section))
  else if (d.config && !d.fileError) queue.push(<Text dimColor>pipeline: no backlog (run /pipeline init)</Text>)

  const lines =
    1 + (isEmpty ? 1 : 0) + open.length + (running.length > 0 ? 1 : 0) + (finished.length > 0 ? 1 : 0) + (planned.length > 0 ? 1 : 0) + (canMore || canFewer ? 1 : 0) + (doneHidden > 0 && !canMore ? 1 : 0) + (planHidden > 0 ? 1 : 0) + queue.length
  const gridH = headerHeight(title) + lines * LINE_H + (running.length + doneRows.length) * ROW_H + planRows.length * PLAN_H
  const card = (a: AgentRun) => <Svg key={a.id} source={agentSvg(W, a, at, a.status === 'running' ? d.limitMs : 0)} alt={`${a.name}: ${modelName(a.model)}, ${a.status}`} width={W} height={ROW_H} />
  return (
    <Box flexDirection="column">
      {gridTiles(gridH).map((tileH, i) => (
        <Svg key={`grid-${i}`} source={gridSvg(W, tileH)} alt="dotted grid" width={W} height={tileH} />
      ))}
      <Box flexDirection="column" position="absolute" top={0} left={0} right={0}>
        <Svg source={headerSvg(W, title, t)} alt={title ? `${title}: ${summary}` : summary} width={W} height={headerHeight(title)} />
        {toggleCompact}
        {open.map(s => (
          <Text color={BLOCKED} bold>
            {signalText(s)}
          </Text>
        ))}
        {isEmpty && <Text dimColor>No subagents yet.</Text>}
        {running.length > 0 && <Text dimColor>{`Running · ${running.length}`}</Text>}
        {running.map(card)}
        {finished.length > 0 && <Button key="done" label={`${d.isDoneCollapsed ? '▸' : '▾'} Finished · ${finished.length}`} plain onPress={d.onDone} />}
        {doneRows.map(card)}
        {canMore && <Button key="more" label={`Show more · ${doneHidden}`} plain onPress={d.onMore} />}
        {canFewer && <Button key="fewer" label="Show fewer" plain onPress={d.onMore} />}
        {doneHidden > 0 && !canMore && <Text dimColor>{`+${doneHidden} · /pipeline status`}</Text>}
        {planned.length > 0 && <Text dimColor>{`Planned · ${planned.length}`}</Text>}
        {planRows.map(p => (
          <Svg key={`plan-${p.n}`} source={plannedSvg(W, p)} alt={`${p.n}. ${p.title}: ${p.status}`} width={W} height={PLAN_H} />
        ))}
        {planHidden > 0 && <Text dimColor>{`+${planHidden} · /pipeline status`}</Text>}
        {queue}
      </Box>
    </Box>
  )
}
