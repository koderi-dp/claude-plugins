// The panel: the dashboard of the 0.2 redesign as a pane, drawn from the same data as the status text.
// The desktop gets the header, the tabs and one of three views: Overview (idle or running, one view that
// switches with the backlog), Queue (search, filters, expandable rows) and History (merged items with their
// PRs). Every other surface gets the text block of spec §9, with the view's name. Nothing is only in the panel.
import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentRun, ChildSession, Item, ItemStatus, Ledger, Panel, QueueFilter, Sibling, Signal, TaskReview, TasksMode, View } from '../types'
import { ACCENT, AGENT_CARD_H, BLOCKED, CAPTION_H, DONE, MERGED_ROW_H, METRICS_H, MUTED, ROW_H, SESSION_ROW_H, TAB_UNDERLINE_H, TASK_BAR_H, agentCardSvg, captionSvg, fmtCost, fmtTime, fmtTokens, heroSvg, itemRowSvg, mergedRowSvg, metricsSvg, modelName, separatorSvg, sessionRowSvg, tabUnderlineSvg, tabWidth, taskBarSvg, taskRowSvg, totals } from './draw'
import type { AgentCard, Hero, Metric } from './draw'
import type { StatusInput, TagKind } from './status'
import { activityLines, currentTask, displayTitle, fmtDuration, groupCounts, heroSentence, idLabel, mergedItems, mergedThisWeek, prLabel, queueItems, roleOf, segmentLegend, siblingLabel, stepsOf, tagOf, taskCounter, taskRowsOf, taskSegment } from './status'

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
/** The command the footer names, at its right. */
const FOOTER_COMMAND = '/pipeline status'
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
  /** The fix rounds allowed per task, for the attempt trail. */
  fixRounds: number
  /** The config's taskReview, for the line under a task the lead read itself. */
  taskReview?: TaskReview
  /** The `tasks` setting: compact drops the sub-lines, the legend, the agent block's details and Recent activity. */
  tasksMode?: TasksMode
  onView: (view: View) => void
  /** Toggles the Recent activity list. */
  onActivity?: () => void
  onFilter: (filter: QueueFilter) => void
  onSearch: (search: string) => void
  onExpand: (id: string | null) => void
  onMore: () => void
  onStop: (item: string) => void
  onLog: (item: string) => void
}

const minutes = (from: number, to: number) => Math.max(0, Math.round((to - from) / 60000))
const line = (parts: unknown[]) => parts.filter(p => p !== undefined && p !== null && p !== '').join(' · ')
const itemText = (item: Item, extra?: string) => line([idLabel(item.id), displayTitle(item.title), item.size, extra])
/** The item's source when it is a web address (an issue's URL), for a Link; empty otherwise. */
const sourceHref = (item: Item): string => (typeof item.source === 'string' && item.source.startsWith('https://') ? item.source : '')
const signalText = (s: Signal) => `${s.kind}: ${line([s.agent, s.detail])}`
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The active item's line for the band: `p12 · Export · task 3/6`. */
export function activeTitle(d: Pick<StatusInput, 'backlog' | 'ledger' | 'activeId'>): string {
  const active = d.activeId !== undefined ? d.backlog?.items.find(i => i.id === d.activeId) : d.backlog?.items.find(i => ACTIVE.includes(i.status))
  if (!active) return ''
  const own = d.ledger && d.ledger.item === active.id ? d.ledger : null
  return line([idLabel(active.id), displayTitle(active.title), taskCounter(own)])
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
        return itemTextRow({ Text, Link }, i, line([i.status, taskCounter(own), own?.resume?.state]), { color: ACCENT })
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
      ...d.children.map(c => <Text color={c.status === 'failed' ? BLOCKED : c.status === 'running' ? ACCENT : undefined}>{line([idLabel(c.item), taskCounter(d.ledgers[c.item] ?? null), c.status, c.lastLine])}</Text>),
      ...d.siblings.map(s => {
        const label = siblingLabel(s)
        return <Text dimColor={s.isStale || label.isIdle}>{line([label.title, label.meta])}</Text>
      }),
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
    items.filter(i => i.status === 'ready').map(i => itemTextRow(ui, i, (i.needs ?? []).length ? `needs ${i.needs!.join(' ')}` : undefined)),
  )
  section(
    'Blocked',
    items.filter(i => i.status === 'blocked').map(i => itemTextRow(ui, i, i.note || 'no reason recorded', { color: BLOCKED })),
  )
  section(
    'Inbox',
    items
      .filter(i => i.status === 'inbox')
      .map(i => {
        const r = d.readiness[i.id]
        return itemTextRow(ui, i, undefined, {}, [r && !r.ready ? <Text dimColor>{` · ${r.reason}`}</Text> : null])
      }),
  )
  const parked = items.filter(i => i.status === 'parked')
  if (parked.length) rows.push(<Text dimColor>{`Parked: ${parked.map(i => idLabel(i.id)).join(', ')}`}</Text>)
  section(
    'Merged this week',
    mergedThisWeek(items, d.now).map(i => {
      const pr = prLabel(i.pr)
      return itemTextRow(ui, i, undefined, { color: DONE }, [pr ? ' · ' : null, pr ? pr.href && Link ? <Link href={pr.href}>{pr.label}</Link> : pr.label : null])
    }),
  )
  return { rows }
}

/**
 * An item's row of the text block, `#12 · Title · M · extra`, then `after`. With a web address as its source (the
 * issue it came from), the id and title are a Link to it.
 */
function itemTextRow(ui: { Text: Comp; Link?: Comp }, item: Item, extra?: string, props: Record<string, unknown> = {}, after: unknown[] = []): Element {
  const { Text, Link } = ui
  const text = itemText(item, extra)
  const href = sourceHref(item)
  if (!Link || !href) return <Text {...props}>{text}{after}</Text>
  const head = line([idLabel(item.id), displayTitle(item.title)])
  return (
    <Text {...props}>
      <Link href={href}>{head}</Link>
      {text.slice(head.length)}
      {after}
    </Text>
  )
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
  const { Box, Text, Button, Svg } = u
  const items = d.backlog?.items ?? []
  const footer = footerText(d.agents, d.signals, d.children)
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
      {tabsRow(u, tabs, d.panel.view, d.onView, W)}
      {notices.length ? <Box flexDirection="column">{notices}</Box> : null}
      {view}
      <Svg key="caption-footer" source={captionSvg(W, footer, FOOTER_COMMAND, true)} alt={line([footer, FOOTER_COMMAND])} width={W} height={CAPTION_H} />
    </Box>
  )
}

/**
 * The tabs: each a Button (a drawing cannot be pressed) over its own underline, a primary bar under the active one,
 * and one hairline under the row. The underline is measured from the label and sits in the tab's own column, so it
 * stays under its Button.
 */
function tabsRow(u: Desk, tabs: { view: View; label: string }[], active: View, onView: (view: View) => void, W: number): Element {
  const { Box, Button, Svg } = u
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        {tabs.map(t => {
          const w = tabWidth(t.label)
          return (
            <Box key={`tab-box-${t.view}`} flexDirection="column" alignItems="flex-start">
              <Button key={`tab-${t.view}`} plain dimColor={active !== t.view} label={t.label} onPress={() => onView(t.view)} />
              <Svg source={tabUnderlineSvg(w, active === t.view)} alt="" width={w} height={TAB_UNDERLINE_H} />
            </Box>
          )
        })}
      </Box>
      <Svg source={separatorSvg(W)} alt="" width={W} height={1} />
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

// A card's border and padding take four columns; the control beside a drawn row (the chevron Button, the PR Link) its own.
const CARD_COLS = 4
const CHEVRON_COLS = 5
const LINK_COLS = 9
/** The width left for a row's drawing inside a card beside a control of `controlCols` columns. */
const rowWidth = (W: number, controlCols: number) => Math.max(120, W - (CARD_COLS + controlCols) * 8)

/** The meta line of an item's row: `M · Inbox`; the reason is the tag's, and a status the tag already says is not repeated. */
const metaOf = (item: Item, tag: { text: string }) => line([item.size, tag.text === cap(item.status) ? undefined : cap(item.status)])

/**
 * A row of a list card as the mockup draws it: the id chip, the title over its meta line and the status tag in one
 * drawing, with the chevron as a Button beside it (a Button holds only text); pressing the chevron runs `onPress`.
 */
function itemRow(u: Desk, item: Item, tag: { text: string; kind: TagKind }, onPress: () => void, W: number, isLast: boolean, isExpanded = false): Element {
  const { Box, Button, Svg } = u
  const title = displayTitle(item.title)
  const meta = metaOf(item, tag)
  const rw = rowWidth(W, CHEVRON_COLS)
  return (
    <Box key={`row-box-${item.id}`} flexDirection="row" alignItems="center" gap={1}>
      <Svg source={itemRowSvg(rw, { id: idLabel(item.id), title, meta, tag, isLast: isLast && !isExpanded })} alt={`${idLabel(item.id)}: ${line([title, meta, tag.text])}`} width={rw} height={ROW_H} />
      <Button key={`row-${item.id}`} plain dimColor label={isExpanded ? '⌄' : '›'} onPress={onPress} />
    </Box>
  )
}

/** A merged item's row: the check, id and title drawn, the PR as a Link (or plain text without an address) at the right. */
function mergedRow(u: Desk, item: Item, W: number, isLast: boolean): Element {
  const { Box, Svg, Text, Link } = u
  const title = displayTitle(item.title)
  const pr = prLabel(item.pr)
  const rw = rowWidth(W, pr ? LINK_COLS : 0)
  return (
    <Box key={`merged-${item.id}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
      <Svg source={mergedRowSvg(rw, { id: idLabel(item.id), title, isLast })} alt={`${idLabel(item.id)}: ${line([title, 'merged', pr?.label])}`} width={rw} height={MERGED_ROW_H} />
      {pr ? pr.href && Link ? <Link href={pr.href}>{`${pr.label} ↗`}</Link> : <Text color={DONE}>{pr.label}</Text> : null}
    </Box>
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
  const active = (d.activeId !== undefined ? items.find(i => i.id === d.activeId && ACTIVE.includes(i.status)) : items.find(i => ACTIVE.includes(i.status))) ?? null
  return active ? renderRunning(u, d, W, active) : renderIdle(u, d, W)
}

function renderIdle(u: Desk, d: PanelInput, W: number): Element {
  const { Box, Svg, Text } = u
  const items = d.backlog?.items ?? []
  const inbox = items.filter(i => i.status === 'inbox')
  const ready = items.filter(i => i.status === 'ready')
  const merged = mergedThisWeek(items, d.now)
  const recent = mergedItems(items, d.now)
  const hero: Hero = {
    kind: 'idle',
    state: 'PIPELINE IDLE',
    headline: 'Nothing running right now',
    line: heroSentence(items),
    chip: ready.length ? 'Ready to build' : 'Awaiting ready work',
    hint: `${d.agents.filter(a => a.status === 'running').length} active agents`,
  }
  const drawn = heroSvg(W, hero)
  // Merged counts this week; the tile says Merged, the alt says the rest.
  const metrics: (Metric & { alt?: string })[] = [
    { value: items.filter(i => ACTIVE.includes(i.status)).length, label: 'Active' },
    { value: ready.length, label: 'Ready' },
    { value: inbox.length, label: 'Inbox' },
    { value: merged.length, label: 'Merged', color: DONE, alt: 'Merged this week' },
  ]
  const list = ready.length ? ready : inbox
  const toQueue = (id: string | null) => () => {
    d.onFilter(ready.length ? 'ready' : 'inbox')
    d.onExpand(id)
    d.onView('queue')
  }
  const shown = list.slice(0, OVERVIEW_ROWS)
  const rows = shown.map((i, n) => {
    const r = d.readiness[i.id]
    const reason = r && !r.ready ? r.reason : undefined
    return itemRow(u, i, tagOf(i, reason), toQueue(i.id), W, n === shown.length - 1 && list.length <= OVERVIEW_ROWS)
  })
  const recentShown = recent.slice(0, OVERVIEW_MERGED)
  const mergedRows = recentShown.map((i, n) => mergedRow(u, i, W, n === recentShown.length - 1))
  return (
    <Box flexDirection="column">
      <Svg source={drawn.source} alt={`${hero.state}: ${hero.headline}. ${hero.line}`} width={W} height={drawn.height} />
      <Box marginTop={1}>
        <Svg source={metricsSvg(W, metrics)} alt={metrics.map(m => `${m.value} ${m.alt ?? m.label}`).join(', ')} width={W} height={METRICS_H} />
      </Box>
      {heading(u, ready.length ? 'Up next' : 'Needs specification', undefined, { key: 'goto-queue', label: 'View queue →', onPress: toQueue(null) })}
      {rows.length ? card(u, [...rows, ...(list.length > OVERVIEW_ROWS ? [<Text key="more-items" dimColor>{`and ${list.length - OVERVIEW_ROWS} more in the queue`}</Text>] : [])]) : <Text dimColor>Nothing waiting. Add work with /pipeline add.</Text>}
      {heading(u, 'Recently merged', undefined, { key: 'goto-history', label: 'View history →', onPress: () => d.onView('history') })}
      {mergedRows.length ? card(u, mergedRows) : <Text dimColor>Nothing merged yet.</Text>}
      {siblingRows(u, d, W)}
    </Box>
  )
}

function renderRunning(u: Desk, d: PanelInput, W: number, active: Item): Element {
  const { Box, Svg, Text, Button } = u
  const items = d.backlog?.items ?? []
  const ledger = d.ledger && d.ledger.item === active.id ? d.ledger : null
  const tasks = ledger?.tasks ?? []
  const done = tasks.filter(t => t.status === 'accepted').length
  const at = Math.max(d.now, ...d.agents.map(a => a.startedAt), 0)
  const running = d.agents.filter(a => a.status === 'running').reverse()
  const t = totals(d.agents, at)
  const current = currentTask(ledger)
  const isCompact = d.tasksMode === 'compact'
  const hero: Hero = {
    kind: 'running',
    state: `${active.status.toUpperCase()} · ${idLabel(active.id).toUpperCase()}`,
    headline: displayTitle(active.title),
    line: d.activeLine || active.note || ledger?.resume?.state || line([active.size, active.status]),
    progress: { done, total: tasks.length },
    steps: stepsOf(active, ledger),
  }
  const drawn = heroSvg(W, hero)
  const usage = `${fmtTime(t.time)} elapsed · ${fmtTokens(t.tokens)} tokens · ≈${fmtCost(t.cost)} cost`
  // The task bar and its legend: one segment per task.
  const segments = tasks.map(task => taskSegment(task, current))
  const legend = segmentLegend(segments)
  // One drawn row per task; without a ledger, the running agents' cards as before.
  const rows = taskRowsOf({ tasks, agents: d.agents, ledger, fixRounds: d.fixRounds, taskReview: d.taskReview, now: at })
  const taskRows = rows.map((r, i) => {
    const row = taskRowSvg(W, r, { isFirst: i === 0, isLast: i === rows.length - 1, isCompact })
    const agent = r.agent ? line([r.agent.role, r.agent.model, r.agent.activity, `${r.agent.calls} tool calls`, `${fmtTokens(r.agent.tokens)} tokens`, `${fmtDuration(r.agent.elapsedMs)} elapsed`]) : undefined
    const alt = line([`Task ${r.n}`, r.title, r.badge, isCompact ? undefined : r.sub, agent, isCompact ? undefined : r.lead, ...(isCompact ? [] : r.history.map(h => h.text))])
    return <Svg key={`task-${r.n}`} source={row.source} alt={alt} width={W} height={row.height} />
  })
  const cards = tasks.length
    ? []
    : running.map(a => {
        const { role, effort } = roleOf(a, ledger)
        const c: AgentCard = { role: cap(role), model: a.model, ...(effort ? { effort } : {}), status: a.status, activity: a.activity, progress: d.limitMs ? Math.min(1, (at - a.startedAt) / d.limitMs) : 0, calls: a.calls, tokens: a.tokens, elapsedMs: at - a.startedAt }
        return <Svg key={a.id} source={agentCardSvg(W, c)} alt={`${c.role}: ${modelName(a.model)}${effort ? ` · ${effort}` : ''}, running, ${a.activity}`} width={W} height={AGENT_CARD_H} />
      })
  const activity = activityLines(tasks, d.taskReview)
  const isActivityOpen = !!d.panel.isActivityOpen
  const ready = items.filter(i => i.status === 'ready')
  const inbox = items.filter(i => i.status === 'inbox')
  const next = ready[0] ?? inbox[0]
  const nextReason = next ? d.readiness[next.id] : undefined
  return (
    <Box flexDirection="column">
      <Svg source={drawn.source} alt={`${hero.state}: ${hero.headline}, ${done} of ${tasks.length} tasks accepted`} width={W} height={drawn.height} />
      <Svg key="caption-usage" source={captionSvg(W, usage)} alt={usage} width={W} height={CAPTION_H} />
      {heading(u, 'Tasks', `${done} of ${tasks.length} accepted`)}
      <Svg source={taskBarSvg(W, segments)} alt={`Task progress: ${legend.map(l => `${l.n} ${l.word}`).join(', ')}`} width={W} height={TASK_BAR_H} />
      {taskRows.length ? (
        <Box flexDirection="column">{taskRows}</Box>
      ) : (
        <Box flexDirection="column">
          {cards}
          <Text dimColor>No ledger yet.</Text>
        </Box>
      )}
      {childRows(u, d)}
      {!isCompact && activity.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row">
            <Button key="activity-toggle" plain dimColor label={isActivityOpen ? 'Recent activity ⌃' : 'Recent activity ⌄'} onPress={() => d.onActivity?.()} />
          </Box>
          {isActivityOpen ? card(u, activity.map((a, i) => <Text key={`activity-${i}`} color={MUTED}>{a}</Text>)) : null}
        </Box>
      ) : null}
      {heading(u, 'Up next', `${ready.length} ready · ${inbox.length} inbox`, { key: 'goto-queue', label: 'View queue →', onPress: () => d.onView('queue') })}
      {next
        ? card(u, [
            itemRow(
              u,
              next,
              tagOf(next, nextReason && !nextReason.ready ? nextReason.reason : undefined),
              () => {
                d.onFilter(next.status === 'ready' ? 'ready' : 'inbox')
                d.onExpand(next.id)
                d.onView('queue')
              },
              W,
              true,
            ),
          ])
        : <Text dimColor>Nothing else waiting.</Text>}
      {siblingRows(u, d, W)}
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
          {line([idLabel(c.item), item ? displayTitle(item.title) : undefined])}
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

/** The other sessions on this repository, from the live file: each a drawn row of title, item and agents; a stale one faded. */
function siblingRows(u: Desk, d: PanelInput, W: number): Element | null {
  const { Box, Svg } = u
  // A session silent for half an hour that runs nothing has ended without saying so: not listed. Before that it is faded.
  const shown = d.siblings.filter(x => d.now - Date.parse(x.seenAt) < 30 * 60_000 || x.agents.some(a => a.status === 'running'))
  if (!shown.length) return null
  // A session with no item and no agent says nothing a row is worth: those are counted in one line.
  const idle = shown.filter(x => siblingLabel(x).isIdle).length
  const busy = shown.filter(x => !siblingLabel(x).isIdle)
  const idleLine = idle ? `${idle} idle session${idle === 1 ? '' : 's'}` : ''
  if (!busy.length) return <Box flexDirection="column">{heading(u, 'Other sessions', idleLine)}</Box>
  const rw = rowWidth(W, 0)
  const rows = busy.map((s, n) => {
    const running = s.agents.filter(a => a.status === 'running').length
    const { title, meta, isIdle } = siblingLabel(s)
    return <Svg key={`sibling-${s.sessionId}`} source={sessionRowSvg(rw, { title, meta, isLive: running > 0, isStale: s.isStale, isDim: isIdle, isLast: n === busy.length - 1 })} alt={line([title, meta])} width={rw} height={SESSION_ROW_H} />
  })
  return (
    <Box flexDirection="column">
      {heading(u, 'Other sessions', line([`${busy.length}`, idleLine]))}
      {card(u, rows)}
    </Box>
  )
}

// ---------- Queue ----------

function renderQueue(u: Desk, d: PanelInput, W: number): Element {
  const { Box, Text, Button, Input, Link } = u
  const items = d.backlog?.items ?? []
  const counts = groupCounts(items)
  const { filter, search, expanded } = d.panel
  const list = queueItems(items, filter, search)
  const rows: Element[] = []
  list.forEach((i, n) => {
    const r = d.readiness[i.id]
    const reason = i.status === 'inbox' && r && !r.ready ? r.reason : undefined
    const isOpen = expanded === i.id
    rows.push(itemRow(u, i, tagOf(i, reason), () => d.onExpand(isOpen ? null : i.id), W, n === list.length - 1, isOpen))
    if (isOpen) {
      rows.push(
        <Box key={`detail-${i.id}`} flexDirection="column" paddingLeft={2} paddingBottom={1}>
          <Text dimColor>{i.note || (reason ? `This item needs a specification before it can become ready (${reason}).` : i.status === 'blocked' ? 'Blocked without a recorded reason.' : 'No note.')}</Text>
          {(i.needs ?? []).length ? <Text dimColor>{`Needs ${i.needs!.join(', ')}`}</Text> : null}
          {i.spec ? <Text dimColor>{`Spec ${i.spec}`}</Text> : null}
          {sourceHref(i) && Link ? <Link href={sourceHref(i)}>{`${idLabel(i.id)} · ${displayTitle(i.title)} ↗`}</Link> : null}
          <Text mono>{`/pipeline status ${i.id}`}</Text>
        </Box>,
      )
    }
  })
  return (
    <Box flexDirection="column">
      {heading(u, 'Work queue', 'Priority order')}
      <Box key="pipeline-search-box" width={d.bodyColumns}>
        <Input key="pipeline-search" placeholder="Find an item by name or id…" value={search} submitLabel="find" onInput={(v: string) => d.onSearch(v)} onSubmit={(v: string) => d.onSearch(v)} />
      </Box>
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
  const { Box, Svg, Text, Button } = u
  const items = d.backlog?.items ?? []
  const all = mergedItems(items, d.now)
  const week = mergedThisWeek(items, d.now)
  // Everything ever merged is the count; the week counts only what the pipeline merged (an import carries no merge date).
  const hero: Hero = { kind: 'history', state: 'HISTORY', headline: `${plural(all.length, 'item')} merged`, line: `all time · ${week.length} this week` }
  const drawn = heroSvg(W, hero)
  const shown = d.panel.isMoreShown ? all : all.slice(0, HISTORY_SHOWN)
  const rows: Element[] = shown.map((i, n) => mergedRow(u, i, W, n === shown.length - 1 && all.length <= HISTORY_SHOWN))
  if (all.length > HISTORY_SHOWN) rows.push(<Button key="history-more" plain label={d.panel.isMoreShown ? 'Show fewer' : `Show all ${all.length} →`} onPress={d.onMore} />)
  return (
    <Box flexDirection="column">
      <Svg source={drawn.source} alt={`${hero.headline}: ${hero.line}`} width={W} height={drawn.height} />
      {heading(u, 'Recent pull requests', 'Most recent first')}
      {rows.length ? card(u, rows) : <Text dimColor>Nothing merged yet.</Text>}
    </Box>
  )
}
