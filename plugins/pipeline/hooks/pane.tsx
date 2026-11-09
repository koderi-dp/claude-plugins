// The panel: the dashboard of the 0.2 redesign as a pane, drawn from the same data as the status text.
// The desktop gets the header, the tabs and one of three views: Overview (idle or running, one view that
// switches with the backlog), Queue (search, filters, expandable rows) and History (merged items with their
// PRs). Every other surface gets the text block of spec §9, with the view's name. Nothing is only in the panel.
import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRun, ChildSession, Item, ItemStatus, Ledger, Panel, QueueFilter, Sibling, Signal, View } from '../types'
import { ACCENT, AGENT_CARD_H, BLOCKED, DONE, METRICS_H, MUTED, agentCardSvg, fmtCost, fmtTime, fmtTokens, heroSvg, metricsSvg, modelName, totals } from './draw'
import type { AgentCard, Hero, Metric } from './draw'
import type { StatusInput, TagKind } from './status'
import { WEEK, currentTask, displayTitle, groupCounts, heroSentence, mergedItems, prLabel, queueItems, roleOf, stepsOf, tagOf, taskCounter } from './status'

export type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Element = RenderElement
// The surface's elements as plain components: the tables differ per surface, the props used here do not.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Comp = (p: Record<string, any>) => Element

export { ACCENT as RUNNING, BLOCKED, DONE }

/** Rows a queue section shows in the text block before the Show more button. */
export const ROWS_SHOWN = 8
/** Rows the Overview's lists show: three to specify or up next, two merged. */
export const OVERVIEW_ROWS = 3
export const OVERVIEW_MERGED = 2
/** Merged rows History shows before the fold. */
export const HISTORY_SHOWN = 20

const ACTIVE: ItemStatus[] = ['planning', 'building', 'review']
const FINISHED_SHOWN = 3
const TAG_COLOR: Record<TagKind, string | undefined> = { running: ACCENT, done: DONE, blocked: BLOCKED, ready: ACCENT, muted: undefined }
const FILTERS: { filter: QueueFilter; label: string }[] = [
  { filter: 'inbox', label: 'Inbox' },
  { filter: 'ready', label: 'Ready' },
  { filter: 'blocked', label: 'Blocked' },
  { filter: 'parked', label: 'Parked' },
  { filter: 'all', label: 'All' },
]

export type PanelInput = StatusInput & {
  surface: string
  /** Whether the surface's table has an Svg element. */
  hasSvg: boolean
  bodyColumns: number
  /** The project's folder name and the branch the session's checkout is on. */
  project: string
  branch: string
  panel: Panel
  /** The children of the session runner and the other sessions on this repository. */
  children: ChildSession[]
  siblings: Sibling[]
  /** The ledgers of the children's items, by item id. */
  ledgers: Record<string, Ledger | null>
  /** The first line of the active item's spec, its What. */
  activeLine: string
  /** The task-minutes limit, for a running card's bar. */
  limitMs: number
  onView: (view: View) => void
  onFilter: (filter: QueueFilter) => void
  onSearch: (search: string) => void
  onExpand: (id: string | null) => void
  onMore: () => void
  onStop: (item: string) => void
  onLog: (item: string) => void
}

const minutes = (from: number, to: number) => Math.max(0, Math.round((to - from) / 60000))
const line = (parts: unknown[]) => parts.filter(p => p !== undefined && p !== null && p !== '').join(' · ')
const itemText = (item: Item, extra?: string) => line([item.id, displayTitle(item.title), item.size, extra])
const signalText = (s: Signal) => `${s.kind}: ${line([s.agent, s.detail])}`
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The active item's line for the band: `p12 · Export · task 3/6`. */
export function activeTitle(d: Pick<StatusInput, 'backlog' | 'ledger'>): string {
  const active = d.backlog?.items.find(i => ACTIVE.includes(i.status))
  if (!active) return ''
  const own = d.ledger && d.ledger.item === active.id ? d.ledger : null
  return line([active.id, displayTitle(active.title), taskCounter(own)])
}

/** The footer's left half: agents running and open signals, or that nothing runs. */
export function footerText(agents: AgentRun[], signals: Signal[], children: ChildSession[]): string {
  const running = agents.filter(a => a.status === 'running').length
  const open = signals.filter(s => !s.delivered).length
  const kids = children.filter(c => c.status === 'running' || c.status === 'starting').length
  if (!running && !kids) return open ? `No subagents running · ${plural(open, 'open signal')}` : 'No subagents running'
  return line([running ? `${plural(running, 'agent')} working` : '', kids ? `${plural(kids, 'session')} running` : '', open ? plural(open, 'open signal') : 'no signals'])
}

/** The panel's tree for the surface at hand. */
export function renderPanel(ui: Ui, d: PanelInput): Element {
  return d.surface === 'desktop' && d.hasSvg ? renderDesktop(ui, d) : renderText(ui, d)
}

// ---------- the text block ----------

/** The text block: the view's name, the head line, the active item, agents, signals, sessions, then the queues, each folded past eight rows. */
export function renderText(ui: Ui, d: PanelInput): Element {
  const { Box, Text, Button, Link } = ui as unknown as { Box: Comp; Text: Comp; Button: Comp; Link?: Comp }
  const { config, backlog, ledger, agents, signals, now, fileError } = d
  const rows: Element[] = []
  const { section, hidden } = sections(Text, rows, d.panel.isMoreShown)

  rows.push(<Text dimColor>{`Pipeline · ${cap(d.panel.view)}`}</Text>)
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
  section(
    'Sessions',
    [
      ...d.children.map(c => <Text color={c.status === 'failed' ? BLOCKED : c.status === 'running' ? ACCENT : undefined}>{line([c.item, taskCounter(d.ledgers[c.item] ?? null), c.status, c.lastLine])}</Text>),
      ...d.siblings.map(s => <Text dimColor={s.isStale}>{line([s.title, s.item, `${plural(s.agents.length, 'agent')}`, s.isStale ? 'stale' : undefined])}</Text>),
    ],
  )
  if (backlog) rows.push(...queueRows({ Text, Link }, d, section).rows)

  if (hidden() > 0 || d.panel.isMoreShown) {
    rows.push(<Button key="more" plain label={d.panel.isMoreShown ? 'Show fewer' : `Show more (${hidden()} hidden)`} onPress={d.onMore} />)
  }
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

/** The queue sections of the text block: Ready, Blocked, Inbox, Parked, Merged this week. */
function queueRows(ui: { Text: Comp; Link?: Comp }, d: PanelInput, section: (title: string, list: Element[]) => void): { rows: Element[] } {
  const { Text, Link } = ui
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
    mergedItems(items, d.now, WEEK).map(i => {
      const pr = prLabel(i.pr)
      return (
        <Text color={DONE}>
          {itemText(i)}
          {pr ? ' · ' : null}
          {pr ? pr.href && Link ? <Link href={pr.href}>{pr.label}</Link> : pr.label : null}
        </Text>
      )
    }),
  )
  return { rows }
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

// ---------- the desktop ----------

type Desk = { Box: Comp; Text: Comp; Button: Comp; Svg: Comp; Input: Comp; Link?: Comp }

/** The desktop: header, tabs, the view, footer. */
function renderDesktop(ui: Ui, d: PanelInput): Element {
  const u = ui as unknown as Desk
  const { Box, Text, Button } = u
  const items = d.backlog?.items ?? []
  const W = Math.max(240, Math.min(900, (d.bodyColumns || 40) * 8 - 8))
  const counts = groupCounts(items)
  const tabs: { view: View; label: string }[] = [
    { view: 'overview', label: 'Overview' },
    { view: 'queue', label: `Queue · ${counts.all}` },
    { view: 'history', label: 'History' },
  ]
  const notices: Element[] = []
  if (d.fileError) notices.push(<Text color={BLOCKED}>{`pipeline: ${d.fileError}`}</Text>)
  if (!d.config && !d.fileError) notices.push(<Text dimColor>pipeline: no config (run /pipeline init)</Text>)
  if (d.config && !d.backlog && !d.fileError) notices.push(<Text dimColor>pipeline: no backlog (run /pipeline init)</Text>)
  for (const s of d.signals.filter(s => !s.delivered)) notices.push(<Text color={BLOCKED} bold>{signalText(s)}</Text>)

  const view = d.panel.view === 'queue' ? renderQueue(u, d, W) : d.panel.view === 'history' ? renderHistory(u, d, W) : renderOverview(u, d, W)
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text weight="bold" size="heading">
          Pipeline
        </Text>
        <Text dimColor>{line([d.project, d.branch])}</Text>
      </Box>
      <Box flexDirection="row" gap={2}>
        {tabs.map(t => (
          <Button key={`tab-${t.view}`} plain dimColor={d.panel.view !== t.view} label={t.label} onPress={() => d.onView(t.view)} />
        ))}
      </Box>
      {notices.length ? <Box flexDirection="column">{notices}</Box> : null}
      {view}
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>{footerText(d.agents, d.signals, d.children)}</Text>
        <Text dimColor mono>
          /pipeline status
        </Text>
      </Box>
    </Box>
  )
}

/** A section heading: the title, a dim subtitle, and a plain Button at the right when the section leads somewhere. */
function heading(u: Desk, title: string, sub?: string, action?: { key: string; label: string; onPress: () => void }): Element {
  const { Box, Text, Button } = u
  return (
    <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
      <Text weight="semibold">
        {title}
        {sub ? <Text dimColor weight="regular">{` · ${sub}`}</Text> : null}
      </Text>
      {action ? <Button key={action.key} plain label={action.label} onPress={action.onPress} /> : null}
    </Box>
  )
}

/** A row of a list card: the id chip, the title, its meta line and a status tag; pressing it runs `onPress`. */
function itemRow(u: Desk, item: Item, meta: string, tag: { text: string; kind: TagKind }, onPress: () => void, isExpanded = false): Element {
  const { Button, Text } = u
  return (
    <Button key={`row-${item.id}`} plain onPress={onPress}>
      <Text color={ACCENT} weight="semibold">
        {item.id}
      </Text>
      {`  ${displayTitle(item.title)}`}
      <Text dimColor>{meta ? `  ${meta}` : ''}</Text>
      {'  '}
      <Text color={TAG_COLOR[tag.kind]} dimColor={tag.kind === 'muted'}>
        {tag.text}
      </Text>
      <Text dimColor>{isExpanded ? '  ⌄' : '  ›'}</Text>
    </Button>
  )
}

/** The card around a list's rows. */
function card(u: Desk, rows: Element[]): Element {
  const { Box } = u
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      {rows}
    </Box>
  )
}

// ---------- Overview ----------

/** One view: the running dashboard while an item is in flight, the idle summary otherwise. */
function renderOverview(u: Desk, d: PanelInput, W: number): Element {
  const items = d.backlog?.items ?? []
  const active = items.find(i => ACTIVE.includes(i.status)) ?? null
  return active ? renderRunning(u, d, W, active) : renderIdle(u, d, W)
}

function renderIdle(u: Desk, d: PanelInput, W: number): Element {
  const { Box, Svg, Text, Link } = u
  const items = d.backlog?.items ?? []
  const inbox = items.filter(i => i.status === 'inbox')
  const ready = items.filter(i => i.status === 'ready')
  const merged = mergedItems(items, d.now, WEEK)
  const hero: Hero = {
    kind: 'idle',
    state: 'PIPELINE IDLE',
    headline: 'Nothing running right now',
    line: heroSentence(items),
    chip: ready.length ? 'Ready to build' : 'Awaiting ready work',
    hint: `${d.agents.filter(a => a.status === 'running').length} active agents`,
  }
  const drawn = heroSvg(W, hero)
  const metrics: Metric[] = [
    { value: inbox.length, label: 'Inbox' },
    { value: ready.length, label: 'Ready', color: ACCENT },
    { value: merged.length, label: 'Merged this week', color: DONE },
  ]
  const list = ready.length ? ready : inbox
  const toQueue = (id: string | null) => () => {
    d.onFilter(ready.length ? 'ready' : 'inbox')
    d.onExpand(id)
    d.onView('queue')
  }
  const rows = list.slice(0, OVERVIEW_ROWS).map(i => {
    const r = d.readiness[i.id]
    const reason = r && !r.ready ? r.reason : undefined
    return itemRow(u, i, line([i.size, i.status === 'ready' ? 'Ready' : reason ? 'Needs specification' : 'Inbox']), tagOf(i, reason), toQueue(i.id))
  })
  const mergedRows = merged.slice(0, OVERVIEW_MERGED).map(i => {
    const pr = prLabel(i.pr)
    return (
      <Box key={`merged-${i.id}`} flexDirection="row" justifyContent="space-between" gap={1}>
        <Text>
          <Text color={DONE}>✓ </Text>
          <Text dimColor>{i.id}</Text>
          {`  ${displayTitle(i.title)}`}
        </Text>
        {pr ? pr.href && Link ? <Link href={pr.href}>{`PR ${pr.label} ↗`}</Link> : <Text color={DONE}>{`PR ${pr.label}`}</Text> : null}
      </Box>
    )
  })
  return (
    <Box flexDirection="column">
      <Svg source={drawn.source} alt={`${hero.state}: ${hero.headline}. ${hero.line}`} width={W} height={drawn.height} />
      <Box marginTop={1}>
        <Svg source={metricsSvg(W, metrics)} alt={metrics.map(m => `${m.value} ${m.label}`).join(', ')} width={W} height={METRICS_H} />
      </Box>
      {heading(u, ready.length ? 'Up next' : 'Needs specification', undefined, { key: 'goto-queue', label: 'View queue →', onPress: toQueue(null) })}
      {rows.length ? card(u, [...rows, ...(list.length > OVERVIEW_ROWS ? [<Text key="more-items" dimColor>{`and ${list.length - OVERVIEW_ROWS} more in the queue`}</Text>] : [])]) : <Text dimColor>Nothing waiting. Add work with /pipeline add.</Text>}
      {heading(u, 'Recently merged', undefined, { key: 'goto-history', label: 'View history →', onPress: () => d.onView('history') })}
      {mergedRows.length ? card(u, mergedRows) : <Text dimColor>Nothing merged this week.</Text>}
      {siblingRows(u, d)}
    </Box>
  )
}

function renderRunning(u: Desk, d: PanelInput, W: number, active: Item): Element {
  const { Box, Svg, Text } = u
  const items = d.backlog?.items ?? []
  const ledger = d.ledger && d.ledger.item === active.id ? d.ledger : null
  const tasks = ledger?.tasks ?? []
  const done = tasks.filter(t => t.status === 'accepted').length
  const at = Math.max(d.now, ...d.agents.map(a => a.startedAt), 0)
  const running = d.agents.filter(a => a.status === 'running').reverse()
  const finished = d.agents
    .filter(a => a.status !== 'running')
    .slice(-FINISHED_SHOWN)
    .reverse()
  const t = totals(d.agents, at)
  const current = currentTask(ledger)
  const hero: Hero = {
    kind: 'running',
    state: `${active.status.toUpperCase()} · ${active.id.toUpperCase()}`,
    headline: displayTitle(active.title),
    line: d.activeLine || active.note || ledger?.resume?.state || line([active.size, active.status]),
    progress: { done, total: tasks.length },
    steps: stepsOf(active, ledger),
  }
  const drawn = heroSvg(W, hero)
  const cards = running.map(a => {
    const { role, effort } = roleOf(a, ledger)
    const c: AgentCard = { role: cap(role), model: a.model, ...(effort ? { effort } : {}), status: a.status, activity: a.activity, progress: d.limitMs ? Math.min(1, (at - a.startedAt) / d.limitMs) : 0, calls: a.calls, tokens: a.tokens, elapsedMs: at - a.startedAt }
    return <Svg key={a.id} source={agentCardSvg(W, c)} alt={`${c.role}: ${modelName(a.model)}${effort ? ` · ${effort}` : ''}, running, ${a.activity}`} width={W} height={AGENT_CARD_H} />
  })
  const timeline = tasks.map(task => {
    const isCurrent = task.status === 'running' || task.status === 'fix' || (task.status === 'pending' && current?.n === task.n)
    const agent = isCurrent ? running[0] : undefined
    const dispatch = task.dispatches.at(-1)
    const mark = task.status === 'accepted' ? '✓' : task.status === 'blocked' ? '✕' : isCurrent ? '●' : '○'
    const word = task.status === 'accepted' ? 'Accepted' : task.status === 'blocked' ? 'Blocked' : task.status === 'fix' ? 'Fix round' : isCurrent ? 'In progress' : 'Pending'
    const color = task.status === 'accepted' ? DONE : task.status === 'blocked' ? BLOCKED : isCurrent ? ACCENT : undefined
    const sub = isCurrent ? line([agent ? modelName(agent.model) : dispatch ? modelName(dispatch.model) : undefined, agent ? `${fmtTime(at - agent.startedAt)} elapsed` : undefined]) : ''
    return (
      <Box key={`task-${task.n}`} flexDirection="column">
        <Text color={color} dimColor={!color}>
          {`${mark} ${task.title}`}
          <Text dimColor>{`  ${word}`}</Text>
        </Text>
        {sub ? <Text dimColor>{`   ${sub}`}</Text> : null}
      </Box>
    )
  })
  const ready = items.filter(i => i.status === 'ready')
  const inbox = items.filter(i => i.status === 'inbox')
  const next = ready[0] ?? inbox[0]
  const nextReason = next ? d.readiness[next.id] : undefined
  return (
    <Box flexDirection="column">
      <Svg source={drawn.source} alt={`${hero.state}: ${hero.headline}, ${done} of ${tasks.length} tasks accepted`} width={W} height={drawn.height} />
      <Text dimColor tabular>
        {`${fmtTime(t.time)} elapsed · ${fmtTokens(t.tokens)} tokens · ≈${fmtCost(t.cost)} cost`}
      </Text>
      {heading(u, 'Active agent', `${running.length} running`, undefined)}
      {current ? <Text dimColor>{`Task ${current.n} / ${tasks.length}`}</Text> : null}
      {cards.length ? cards : <Text dimColor>No subagent running.</Text>}
      {finished.map(a => (
        <Text key={`finished-${a.id}`} color={a.status === 'failed' ? BLOCKED : DONE} dimColor={a.status !== 'failed'}>
          {line([a.name, modelName(a.model), fmtTime((a.endedAt ?? at) - a.startedAt), a.status])}
        </Text>
      ))}
      {childRows(u, d)}
      {heading(u, 'Task progress', undefined, { key: 'goto-queue', label: 'All work →', onPress: () => d.onView('queue') })}
      {timeline.length ? <Box flexDirection="column">{timeline}</Box> : <Text dimColor>No ledger yet.</Text>}
      {heading(u, 'Up next', `${ready.length} ready · ${inbox.length} inbox`)}
      {next ? card(u, [itemRow(u, next, line([next.size, next.status === 'ready' ? 'Ready' : nextReason && !nextReason.ready ? 'Needs specification' : 'Inbox']), tagOf(next, nextReason && !nextReason.ready ? nextReason.reason : undefined), () => {
        d.onFilter(next.status === 'ready' ? 'ready' : 'inbox')
        d.onExpand(next.id)
        d.onView('queue')
      })]) : <Text dimColor>Nothing else waiting.</Text>}
      {siblingRows(u, d)}
    </Box>
  )
}

/** The session runner's children: one card per child with its item, task counter, status, Stop and Log. */
function childRows(u: Desk, d: PanelInput): Element | null {
  const { Box, Text, Button } = u
  if (!d.children.length) return null
  const rows = d.children.map(c => {
    const item = d.backlog?.items.find(i => i.id === c.item)
    const isLive = c.status === 'running' || c.status === 'starting'
    return (
      <Box key={`child-${c.item}`} flexDirection="row" justifyContent="space-between" gap={1}>
        <Text color={c.status === 'failed' ? BLOCKED : isLive ? ACCENT : undefined}>
          {line([c.item, item ? displayTitle(item.title) : undefined])}
          <Text dimColor>{`  ${line([taskCounter(d.ledgers[c.item] ?? null), c.status, c.lastLine])}`}</Text>
        </Text>
        <Box flexDirection="row" gap={1}>
          {isLive ? <Button key={`stop-${c.item}`} label="Stop" onPress={() => d.onStop(c.item)} /> : null}
          <Button key={`log-${c.item}`} label="Log" onPress={() => d.onLog(c.item)} />
        </Box>
      </Box>
    )
  })
  return (
    <Box flexDirection="column">
      {heading(u, 'Sessions', `${d.children.filter(c => c.status === 'running' || c.status === 'starting').length} running`)}
      {card(u, rows)}
    </Box>
  )
}

/** The other sessions on this repository, from the live file: title, item, agents; a stale one dim. */
function siblingRows(u: Desk, d: PanelInput): Element | null {
  const { Box, Text } = u
  if (!d.siblings.length) return null
  const rows = d.siblings.map(s => (
    <Text key={`sibling-${s.sessionId}`} dimColor={s.isStale}>
      {s.title}
      <Text dimColor>{`  ${line([s.item, plural(s.agents.filter(a => a.status === 'running').length, 'agent'), s.isStale ? 'stale' : undefined])}`}</Text>
    </Text>
  ))
  return (
    <Box flexDirection="column">
      {heading(u, 'Other sessions', `${d.siblings.length}`)}
      {card(u, rows)}
    </Box>
  )
}

// ---------- Queue ----------

function renderQueue(u: Desk, d: PanelInput, _W: number): Element {
  const { Box, Text, Button, Input } = u
  const items = d.backlog?.items ?? []
  const counts = groupCounts(items)
  const { filter, search, expanded } = d.panel
  const list = queueItems(items, filter, search)
  const rows: Element[] = []
  for (const i of list) {
    const r = d.readiness[i.id]
    const reason = i.status === 'inbox' && r && !r.ready ? r.reason : undefined
    const isOpen = expanded === i.id
    rows.push(itemRow(u, i, line([i.size, cap(i.status), reason]), tagOf(i, reason), () => d.onExpand(isOpen ? null : i.id), isOpen))
    if (isOpen) {
      rows.push(
        <Box key={`detail-${i.id}`} flexDirection="column" paddingLeft={2} paddingBottom={1}>
          <Text dimColor>{i.note || (reason ? `This item needs a specification before it can become ready (${reason}).` : i.status === 'blocked' ? 'Blocked without a recorded reason.' : 'No note.')}</Text>
          {(i.needs ?? []).length ? <Text dimColor>{`Needs ${i.needs!.join(', ')}`}</Text> : null}
          {i.spec ? <Text dimColor>{`Spec ${i.spec}`}</Text> : null}
          <Text mono>{`/pipeline status ${i.id}`}</Text>
        </Box>,
      )
    }
  }
  return (
    <Box flexDirection="column">
      {heading(u, 'Work queue', 'Priority order')}
      <Input key="pipeline-search" placeholder="Find an item by name or id…" value={search} submitLabel="search" onInput={(v: string) => d.onSearch(v)} onSubmit={(v: string) => d.onSearch(v)} />
      <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
        {FILTERS.map(f => (
          <Button key={`filter-${f.filter}`} plain dimColor={filter !== f.filter} label={`${f.label} · ${counts[f.filter]}`} onPress={() => d.onFilter(f.filter)} />
        ))}
      </Box>
      <Text dimColor>{`${plural(list.length, 'item')} · ${filter}${search.trim() ? ` · “${search.trim()}”` : ''}`}</Text>
      {rows.length ? card(u, rows) : <Text dimColor>No matching items in this section.</Text>}
    </Box>
  )
}

// ---------- History ----------

function renderHistory(u: Desk, d: PanelInput, W: number): Element {
  const { Box, Svg, Text, Button, Link } = u
  const items = d.backlog?.items ?? []
  const all = mergedItems(items, d.now)
  const week = mergedItems(items, d.now, WEEK)
  const hero: Hero = { kind: 'history', state: 'HISTORY', headline: `${plural(week.length, 'item')} merged`, line: 'Completed this week · last 7 days' }
  const drawn = heroSvg(W, hero)
  const shown = d.panel.isMoreShown ? all : all.slice(0, HISTORY_SHOWN)
  const rows = shown.map(i => {
    const pr = prLabel(i.pr)
    return (
      <Box key={`history-${i.id}`} flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text color={DONE} weight="semibold">
            {i.id}
          </Text>
          <Text>{displayTitle(i.title)}</Text>
          <Text color={DONE}>✓ Merged</Text>
        </Box>
        {pr ? pr.href && Link ? <Link href={pr.href}>{`${pr.label} ↗`}</Link> : <Text color={DONE}>{pr.label}</Text> : null}
      </Box>
    )
  })
  if (all.length > HISTORY_SHOWN) rows.push(<Button key="history-more" plain label={d.panel.isMoreShown ? 'Show fewer' : `Show all ${all.length} →`} onPress={d.onMore} />)
  return (
    <Box flexDirection="column">
      <Svg source={drawn.source} alt={`${hero.headline}: ${hero.line}`} width={W} height={drawn.height} />
      {heading(u, 'Recent pull requests', 'Most recent first')}
      {rows.length ? card(u, rows) : <Text dimColor>Nothing merged yet.</Text>}
    </Box>
  )
}
