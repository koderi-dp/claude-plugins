// Five states of the panel with dummy data, in the shape `renderPanel` consumes (PanelInput: pane.tsx) and as
// drawPane in register.tsx gathers it. Pure data; nothing here is loaded by the plugin.

import type { AgentRun, Config, Item, Ledger, Panel, Sibling } from '../types'
import { DEFAULTS } from '../hooks/config'
import type { PanelInput } from '../hooks/pane'
import type { Readiness } from '../hooks/backlog'

export const NOW = Date.parse('2026-11-09T10:00:00Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

const noop = () => {}
const PANEL: Panel = { view: 'overview', filter: 'inbox', search: '', expanded: null, isMoreShown: false, autoOpenedFor: '', isBandOpen: false }
const CONFIG: Config = { ...DEFAULTS, taskReview: 'off' }

const item = (id: string, title: string, status: Item['status'], extra: Partial<Item> = {}): Item => ({ id, title, status, size: 'M', updatedAt: iso(NOW - 3 * 24 * 60 * MIN), ...extra })

const INBOX_TITLES = [
  'Empty grid areas refilled after a card resize',
  'Brand logos on product cards',
  'Table element for specification and price tables',
  'Card style applied across pages',
  'Grid line snapping on the canvas',
  'Brand and price-list filters in the article list',
  'Article editing and status',
  'Attributes, Catalogs and History tabs',
  'New article form',
  'Categories dialog parent picker',
  'Repair a missing default price list after a bootstrap failure',
  'Membership query cost during context.db integration',
  'Organization plugin endpoint boundary review',
  'PDF export of a single page',
  'Image proxy with EXIF stripping',
  'Keyboard shortcuts reference',
  'Grid template gallery',
  'Palette for the dark theme',
  'Import wizard for Excel price lists',
  'Catalog sharing links',
  'Version history of a catalog',
  'Undo and redo across the editor',
  'Snapping guides between cards',
  'Rulers and the grid overlay',
  'Font loading for brand fonts',
  'Text box auto-fit',
  'Export settings per catalog',
]

/** 71 items like catalo's queue: 27 inbox, 1 ready, 10 parked, 33 merged (the first 28 imported, 5 merged this week). */
export function catalo(): Item[] {
  const inbox = INBOX_TITLES.map((t, i) => item(`p${40 + i}`, t, 'inbox'))
  const ready = [item('p39', 'grid-track-sizes — Grid row and column sizes', 'ready', { spec: 'docs/pipeline/specs/p39.md', size: 'L' })]
  const parked = Array.from({ length: 10 }, (_, i) => item(`p${67 + i}`, ['Integrations', 'ERP connectors', 'AI layout suggestions', 'Public API', 'Webhooks', 'Multi-currency', 'Localization of the shell', 'Print shop hand-off', 'Analytics', 'Mobile preview'][i]!, 'parked', { size: 'L' }))
  const imported = Array.from({ length: 28 }, (_, i) => item(`p${i + 1}`, ['Foundation plan, Tasks 1–9', 'Plan 1b: tenant isolation', 'Catalog UI fixes (Keraterm review)', 'Hybrid editor, Phase B: document v2'][i % 4] + (i > 3 ? ` · part ${Math.floor(i / 4) + 1}` : ''), 'merged', { pr: `https://github.com/koderi-dp/catalo/pull/${i + 1}`, updatedAt: iso(NOW - 10 * 24 * 60 * MIN), note: 'imported from docs/backlog.md' }))
  const week = Array.from({ length: 5 }, (_, i) => item(`p${29 + i}`, ['AstroVista theme preset', 'Verification speedups', 'Category picker and article page', 'Page document v2: four margins', 'Slot styles and image fit'][i]!, 'merged', { pr: `https://github.com/koderi-dp/catalo/pull/${29 + i}`, updatedAt: iso(NOW - (5 - i) * 24 * 60 * MIN) }))
  return [...imported, ...week, ...ready, ...inbox, ...parked]
}

/** Every inbox item without a spec, the ready one ready. */
const readinessOf = (items: Item[]): Record<string, Readiness> => Object.fromEntries(items.filter(i => i.status === 'inbox' || i.status === 'ready').map(i => [i.id, i.status === 'ready' ? { ready: true } : { ready: false, reason: 'no spec' }]))

const base = (items: Item[], over: Partial<PanelInput> = {}): PanelInput => ({
  config: CONFIG,
  backlog: { version: 1, items },
  readiness: readinessOf(items),
  ledger: null,
  agents: [],
  signals: [],
  now: NOW,
  fileError: null,
  surface: 'desktop',
  hasSvg: true,
  bodyColumns: 65,
  project: 'catalo',
  branch: 'main',
  panel: PANEL,
  children: [],
  siblings: [],
  ledgers: {},
  activeLine: '',
  limitMs: DEFAULTS.limits.taskMinutes * MIN,
  fixRounds: 2,
  taskReview: 'off',
  onView: noop,
  onFilter: noop,
  onSearch: noop,
  onExpand: noop,
  onMore: noop,
  onStop: noop,
  onLog: noop,
  ...over,
})

const staleSibling: Sibling = { sessionId: 'other', title: 'catalo', cwd: '/home/user/catalo-2', branch: 'main', seenAt: iso(NOW - 12 * MIN), agents: [], signals: [], isStale: true }

export const idle = (): PanelInput => base(catalo(), { siblings: [staleSibling] })

const P72 = item('p72', 'Grid track interaction', 'building', { spec: 'docs/pipeline/specs/p72.md', branch: 'feat/p72', size: 'L', updatedAt: iso(NOW - 15 * MIN) })
const TASKS: Ledger['tasks'] = [
  { n: 1, title: 'Grid line model and track-resize gesture', status: 'accepted', dispatches: [{ role: 'implementer', model: 'claude-opus-5-5', effort: 'medium', tokens: 820_000, minutes: 4.57, result: 'done' }], review: { kind: 'lead-diff', verdict: 'accepted' } },
  { n: 2, title: 'Canvas: drawn grid, draggable boundaries, keyboard and double-click', status: 'running', dispatches: [{ role: 'implementer', model: 'claude-opus-5-5', effort: 'medium', tokens: 0, minutes: 0, result: '' }] },
  { n: 3, title: 'The Page tab follows the drag live, in both editors', status: 'pending', dispatches: [] },
]
const ledgerOf = (tasks: Ledger['tasks'], resume: Ledger['resume']): Ledger => ({ item: 'p72', plan: 'docs/pipeline/plans/p72.md', branch: 'feat/p72', worktree: '.claude/worktrees/p72', resume, tasks, rulings: [], blockers: [], final: null, tokens: 2_500_000 })

/** The building queue: p72 in flight before the same 27 inbox items and the parked ones, the ready one taken. */
const building = (): Item[] => [...catalo().filter(i => i.status !== 'ready'), P72].sort((a, b) => (a.status === 'merged' ? 0 : 1) - (b.status === 'merged' ? 0 : 1))

export const running = (): PanelInput => {
  const started = NOW - 2 * MIN - 36_000
  const agent: AgentRun = { id: 't2', agentId: 'a2', name: 'Implement task 2', model: 'claude-opus-5-5', status: 'running', startedAt: started, lastStepAt: NOW - 4000, calls: 18, tokens: 1_400_000, activity: 'running npx prettier', lastCommands: ['npx prettier --check .'], failures: 0 }
  const earlier: AgentRun = { id: 't1', agentId: 'a1', name: 'Implement task 1', model: 'claude-opus-5-5', status: 'done', startedAt: NOW - 9 * MIN, lastStepAt: NOW - 5 * MIN, endedAt: NOW - 4 * MIN - 26_000, calls: 41, tokens: 820_000, activity: 'reported', lastCommands: [], failures: 0 }
  return base(building(), {
    ledger: ledgerOf(TASKS, { task: 2, state: 'task 2 dispatched', at: iso(started) }),
    agents: [earlier, agent],
    activeLine: 'Resizable grid tracks on the canvas: drag a boundary, the Page tab follows live.',
    branch: 'feat/p72',
  })
}

export const fixRound = (): PanelInput => {
  const tasks: Ledger['tasks'] = [
    TASKS[0]!,
    {
      n: 2,
      title: 'Canvas: drawn grid, draggable boundaries, keyboard and double-click',
      status: 'fix',
      dispatches: [
        { role: 'implementer', model: 'claude-sonnet-5-5', effort: 'medium', tokens: 610_000, minutes: 3.33, result: 'done' },
        { role: 'reviewer', model: 'claude-opus-5-5', effort: 'high', tokens: 240_000, minutes: 0.97, result: 'FIX REQUIRED: the double-click reset has no test and the keyboard step ignores the minimum track size' },
        { role: 'implementer', model: 'claude-sonnet-5-5', effort: 'medium', tokens: 0, minutes: 0, result: '' },
      ],
    },
    TASKS[2]!,
  ]
  const agents: AgentRun[] = [
    { id: 't1', agentId: 'a1', name: 'Implement task 1', model: 'claude-opus-5-5', status: 'done', startedAt: NOW - 20 * MIN, lastStepAt: NOW - 16 * MIN, endedAt: NOW - 15 * MIN - 26_000, calls: 41, tokens: 820_000, activity: 'reported', lastCommands: [], failures: 0 },
    { id: 't2', agentId: 'a2', name: 'Implement task 2', model: 'claude-sonnet-5-5', status: 'done', startedAt: NOW - 8 * MIN, lastStepAt: NOW - 5 * MIN, endedAt: NOW - 4 * MIN - 40_000, calls: 33, tokens: 610_000, activity: 'reported', lastCommands: [], failures: 0 },
    { id: 't3', agentId: 'a3', name: 'Review task 2', model: 'claude-opus-5-5', status: 'done', startedAt: NOW - 3 * MIN, lastStepAt: NOW - 2 * MIN, endedAt: NOW - 2 * MIN - 2000, calls: 12, tokens: 240_000, activity: 'reported', lastCommands: [], failures: 0 },
  ]
  return base(building(), {
    ledger: ledgerOf(tasks, { task: 2, state: 'fix round 1 dispatched', at: iso(NOW - 40_000) }),
    agents,
    activeLine: 'Resizable grid tracks on the canvas: drag a boundary, the Page tab follows live.',
    branch: 'feat/p72',
  })
}

export const queue = (): PanelInput => base(catalo(), { panel: { ...PANEL, view: 'queue', filter: 'inbox', search: 'grid', expanded: 'p44' } })

export const history = (): PanelInput => base(catalo(), { panel: { ...PANEL, view: 'history' } })

export const STATES: Record<string, () => PanelInput> = { idle, running, fixRound, queue, history }
