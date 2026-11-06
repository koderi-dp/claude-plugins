import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { BLOCKED, DONE, ROWS_SHOWN, RUNNING } from './pane'

const MAIN = '/p/main'
const DIR = `${MAIN}/docs/pipeline`
const CONFIG = `${DIR}/config.json`
const BACKLOG = `${DIR}/backlog.json`
const NOW = Date.parse('2026-11-05T10:00:00Z')
const MIN = 60_000
const PANE = { title: 'Pipeline', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as const

const VALID_CONFIG = JSON.stringify({ version: 1, mainBranch: 'main', branch: 'feat/<id>', checks: {}, merge: 'pr', notify: 'off' }, null, 2) + '\n'

type Engine = {
  session: { start: (e: never) => Promise<unknown> }
  agent: { spawn: (e: never) => Promise<unknown> }
  turn: { complete: unknown }
  ui: { mount: (e: never) => Promise<Mounted> }
  command: { run: (e: never) => Promise<unknown> }
}
type Found = { type: string; key?: string; props: Record<string, unknown>; text: string } | undefined
type Mounted = { find: (q: Record<string, unknown>) => Promise<Found>; findAll: (q: Record<string, unknown>) => Promise<NonNullable<Found>[]>; press: (t: Record<string, unknown>) => Promise<unknown>; unmount: () => Promise<void> }

/** A main checkout at /p/main, files in memory, a surface that records which panes are open, an engine that draws "engine" beneath. */
function world(on: On, seed: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>(Object.entries(seed))
  const panes: string[] = []
  const opened: string[] = []
  const key = (p: string) => p.split(String.fromCharCode(92)).join('/')
  on('fs.exists', (_$, e) => ({ value: files.has(key(e.path)) }))
  on('fs.read', (_$, e) => {
    const t = files.get(key(e.path))
    return t === undefined ? { deny: `ENOENT: ${e.path}` } : { value: t }
  })
  on('fs.write', (_$, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    if (!panes.includes(e.id)) panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    panes.splice(panes.indexOf(e.id), 1)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: panes.map(id => ({ id, title: 'Pipeline', isPlaced: true })) }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.repo', () => ({ value: { root: MAIN, remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: MAIN }))
  on('session.cwd', () => ({ value: MAIN }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('tool.list', () => ({ value: [] }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  on('turn.complete', () => ({ text: '' }) as never)
  return { clock, files, panes, opened }
}

const start = ($: Engine) => $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true } as never)
const spawn = ($: Engine, description: string, n = 1) =>
  $.agent.spawn({ tool_use_id: `t${n}`, prompt: 'p', description, subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-x', background: false, fork: false } as never)
const complete = ($: Engine, e: Record<string, unknown>) => ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', ...e })
const mount = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => $.ui.mount({ plugin: 'pipeline', surface, component: 'Pane', requestId: 'pipeline', props: PANE } as never)
const band = ($: Engine, surface: 'terminal' | 'desktop') => $.ui.mount({ plugin: 'pipeline', surface, component: 'AbovePrompt', props: BAND } as never)
const run = async ($: Engine, args: string) => ((await $.command.run({ command: 'pipeline', args, origin: { kind: 'composer' } } as never)) as { text?: string }).text ?? ''

const item = (id: string, title: string, status: string, extra: Record<string, unknown> = {}) => ({ id, title, status, size: 'M', updatedAt: '2026-11-05T09:00:00Z', ...extra })
const backlogOf = (items: Record<string, unknown>[]) => JSON.stringify({ version: 1, items }, null, 2) + '\n'

const QUEUE = backlogOf([
  item('p1', 'Login', 'merged', { pr: '#3' }),
  item('p2', 'Export', 'building'),
  item('p3', 'Search', 'ready'),
  item('p4', 'Import', 'blocked', { note: 'CI red after one fix' }),
  item('p5', 'Billing', 'inbox'),
  item('p6', 'Old', 'merged', { pr: '#1', updatedAt: '2026-10-01T09:00:00Z' }),
  item('p7', 'Later', 'parked'),
])
const LEDGER =
  JSON.stringify(
    {
      item: 'p2',
      tasks: [
        { n: 1, title: 'The parser', status: 'accepted', dispatches: [] },
        { n: 2, title: 'The writer', status: 'running', dispatches: [] },
        { n: 3, title: 'The command', status: 'pending', dispatches: [] },
      ],
      rulings: [],
      blockers: [],
      tokens: 0,
      resume: { task: 2, state: 'task 1 accepted', at: '2026-11-05T09:30:00Z' },
    },
    null,
    2,
  ) + '\n'
const SEED = { [CONFIG]: VALID_CONFIG, [BACKLOG]: QUEUE, [`${DIR}/ledgers/p2.json`]: LEDGER }

test('terminal: every section with its colour, the active item with its task counter, agents and signals, no Svg', async ($, on) => {
  const { clock } = world(on, SEED)
  await start($ as never)
  await spawn($ as never, 'Implement task 2', 1)
  await spawn($ as never, 'Review task 1', 2)
  await clock.advance(5 * MIN)
  await complete($ as never, { agentId: 'agent-t2', reason: 'error' })
  const ui = await mount($ as never, 'terminal')
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await ui.find({ type: 'Text', text: /7 items · 1 ready/ }))?.text).toBe('pipeline: 7 items · 1 ready')
  const active = await ui.find({ type: 'Text', text: /p2 · Export/ })
  expect(active?.text).toBe('p2 · Export · M · building · task 2/3 · task 1 accepted')
  expect(active?.props['color']).toBe(RUNNING)
  const running = await ui.find({ type: 'Text', text: /Implement task 2/ })
  expect(running?.text).toContain('5 min')
  expect(running?.props['color']).toBe(RUNNING)
  const failed = await ui.find({ type: 'Text', text: /Review task 1/ })
  expect(failed?.text).toContain('failed')
  expect(failed?.props['color']).toBe(BLOCKED)
  expect((await ui.find({ type: 'Text', text: /p3 · Search/ }))?.props['color']).toBeUndefined()
  const blocked = await ui.find({ type: 'Text', text: /p4 · Import/ })
  expect(blocked?.text).toBe('p4 · Import · M · CI red after one fix')
  expect(blocked?.props['color']).toBe(BLOCKED)
  expect((await ui.find({ type: 'Text', text: /p5 · Billing/ }))?.text).toContain('no spec')
  expect(await ui.find({ type: 'Text', text: /Parked: p7/ })).toBeDefined()
  const merged = await ui.find({ type: 'Text', text: /p1 · Login/ })
  expect(merged?.text).toBe('p1 · Login · M · #3')
  expect(merged?.props['color']).toBe(DONE)
  expect(await ui.find({ type: 'Text', text: /p6 · Old/ })).toBeUndefined()
  expect(await ui.find({ key: 'more' })).toBeUndefined()
  // A silent agent past silentMinutes: the signal row in the blocked colour.
  await clock.advance(11 * MIN)
  const signal = await ui.find({ type: 'Text', text: /^silent:/ })
  expect(signal?.text).toContain('Implement task 2')
  expect(signal?.props['color']).toBe(BLOCKED)
  await ui.unmount()
})

test('desktop: the grid, the header with the item and its counter, one card per agent, plan rows, the queue, the signal row', async ($, on) => {
  const { clock } = world(on, SEED)
  await start($ as never)
  await spawn($ as never, 'Implement task 2', 1)
  await spawn($ as never, 'Review task 1', 2)
  await clock.advance(5 * MIN)
  await complete($ as never, { agentId: 'agent-t2', reason: 'error' })
  const ui = await mount($ as never, 'desktop')
  const svgs = await ui.findAll({ type: 'Svg' })
  const alts = svgs.map(s => String(s.props['alt']))
  expect(alts[0]).toBe('dotted grid')
  expect(alts[1]).toMatch(/^p2 · Export · task 2\/3: ≈\$\d/)
  expect(String(svgs[1]!.props['source'])).toContain('p2 · Export · task 2/3')
  expect(alts).toContain('Implement task 2: Sonnet 5.5, running')
  expect(alts).toContain('Review task 1: Sonnet 5.5, failed')
  expect(alts).toContain('3. The command: pending')
  expect(svgs.every(s => String(s.props['source']).startsWith('<svg'))).toBe(true)
  const card = svgs.find(s => s.props['alt'] === 'Implement task 2: Sonnet 5.5, running')
  expect(String(card?.props['source'])).toContain('5:00')
  expect(await ui.find({ type: 'Text', text: 'Running · 1' })).toBeDefined()
  expect((await ui.find({ key: 'done' }))?.props['label']).toBe('▾ Finished · 1')
  expect(await ui.find({ type: 'Text', text: 'Planned · 1' })).toBeDefined()
  expect((await ui.find({ key: 'compact' }))?.props['label']).toBe('Collapse')
  // The queue below, as text.
  expect((await ui.find({ type: 'Text', text: /p4 · Import/ }))?.props['color']).toBe(BLOCKED)
  expect((await ui.find({ type: 'Text', text: /p1 · Login/ }))?.props['color']).toBe(DONE)
  expect(await ui.find({ type: 'Text', text: /p3 · Search/ })).toBeDefined()
  // Collapsed: the compact strip and the toggle, nothing else.
  await ui.press({ key: 'compact' })
  expect((await ui.findAll({ type: 'Svg' })).map(s => String(s.props['alt']))).toEqual(['2 agents, ≈$0.00 · 0 tokens · 5:00'])
  expect((await ui.find({ key: 'compact' }))?.props['label']).toBe('Expand')
  await ui.press({ key: 'compact' })
  // Finished folds.
  await ui.press({ key: 'done' })
  expect((await ui.find({ key: 'done' }))?.props['label']).toBe('▸ Finished · 1')
  expect((await ui.findAll({ type: 'Svg' })).map(s => String(s.props['alt']))).not.toContain('Review task 1: Sonnet 5.5, failed')
  // A silent agent: the highlighted row above Running.
  await clock.advance(11 * MIN)
  const signal = await ui.find({ type: 'Text', text: /^silent:/ })
  expect(signal?.props['color']).toBe(BLOCKED)
  await ui.unmount()
})

test('desktop: finished rows fold at eight and Show more opens up to twenty-four', async ($, on) => {
  world(on, SEED)
  await start($ as never)
  for (let i = 1; i <= 30; i++) {
    await spawn($ as never, `Task ${i}`, i)
    await complete($ as never, { agentId: `agent-t${i}`, reason: 'answer' })
  }
  const ui = await mount($ as never, 'desktop')
  const cards = async () => (await ui.findAll({ type: 'Svg' })).filter(s => String(s.props['alt']).startsWith('Task ')).length
  expect(await cards()).toBe(8)
  expect((await ui.find({ key: 'more' }))?.props['label']).toBe('Show more · 22')
  await ui.press({ key: 'more' })
  expect(await cards()).toBe(24)
  expect(await ui.find({ key: 'fewer' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+6 · /pipeline status' })).toBeDefined()
  await ui.unmount()
})

test('terminal: a queue section folds past eight rows and Show more unfolds every section', async ($, on) => {
  const many = Array.from({ length: 12 }, (_, i) => item(`p${i + 1}`, `Ready ${i + 1}`, 'ready'))
  const inbox = Array.from({ length: 10 }, (_, i) => item(`i${i + 1}`, `Inbox ${i + 1}`, 'inbox'))
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: backlogOf([...many, ...inbox]) })
  await start($ as never)
  const ui = await mount($ as never)
  expect(await ui.find({ type: 'Text', text: /Ready 8 · M/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Ready 9 · M/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Inbox 9/ })).toBeUndefined()
  expect((await ui.find({ key: 'more' }))?.props['label']).toBe(`Show more (${12 - ROWS_SHOWN + 10 - ROWS_SHOWN} hidden)`)
  await ui.press({ key: 'more' })
  expect(await ui.find({ type: 'Text', text: /Ready 12 · M/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Inbox 10/ })).toBeDefined()
  expect((await ui.find({ key: 'more' }))?.props['label']).toBe('Show fewer')
  await ui.press({ key: 'more' })
  expect(await ui.find({ type: 'Text', text: /Ready 9 · M/ })).toBeUndefined()
  await ui.unmount()
})

test('without a config the panel says so', async ($, on) => {
  world(on)
  await start($ as never)
  const ui = await mount($ as never)
  expect(await ui.find({ type: 'Text', text: 'pipeline: no config (run /pipeline init)' })).toBeDefined()
  await ui.unmount()
})

test('a file error is drawn in the blocked colour', async ($, on) => {
  world(on, { [CONFIG]: '{\n  "version": 1,\n  merge: "pr"\n}\n' })
  await start($ as never)
  const ui = await mount($ as never)
  const row = await ui.find({ type: 'Text', text: /^pipeline: docs\/pipeline\/config\.json: line \d+: / })
  expect(row).toBeDefined()
  expect(row?.props['color']).toBe(BLOCKED)
  await ui.unmount()
})

test('/pipeline panel toggles the pane; the first agent opens it once', async ($, on) => {
  const { panes, opened } = world(on, SEED)
  await start($ as never)
  expect(panes).toEqual([])
  expect(await run($ as never, 'panel')).toBe('Pipeline panel opened.')
  expect(panes).toEqual(['pipeline'])
  expect(await run($ as never, 'panel')).toBe('Pipeline panel closed.')
  expect(panes).toEqual([])
  await spawn($ as never, 'Implement task 2', 1)
  expect(panes).toEqual(['pipeline'])
  await run($ as never, 'panel')
  expect(panes).toEqual([])
  await spawn($ as never, 'Implement task 3', 2)
  expect(panes).toEqual([])
  expect(opened).toEqual(['pipeline', 'pipeline'])
})

test('the band above the prompt draws nothing of its own without a building item', async ($, on) => {
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: backlogOf([item('p3', 'Search', 'ready')]) })
  await start($ as never)
  const ui = await band($ as never, 'terminal')
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('the band above the prompt: the item line and the bar while an item builds, text on the terminal and one Svg on the desktop', async ($, on) => {
  const { clock } = world(on, SEED)
  await start($ as never)
  await spawn($ as never, 'Implement task 2', 1)
  await clock.advance(14 * MIN)
  let ui = await band($ as never, 'terminal')
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await ui.find({ type: 'Text', text: /p2 · Export/ }))?.text).toBe('p2 · Export · task 2/3 · Implement task 2 · Sonnet 5.5 · 14 min')
  const bar = await ui.find({ type: 'Text', text: /^[█░]+$/ })
  expect(bar?.props['color']).toBe(RUNNING)
  expect(bar?.text.indexOf('░')).toBeGreaterThan(0)
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()

  ui = await band($ as never, 'desktop')
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(1)
  expect(svgs[0]!.props['alt']).toBe('p2: p2 · Export · task 2/3 · Implement task 2 · Sonnet 5.5 · 14 min')
  expect(String(svgs[0]!.props['source'])).toContain('33%')
  await ui.unmount()
})
