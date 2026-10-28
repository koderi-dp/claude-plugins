import { expect, mock, test } from 'claude-code/testing'

const PROGRESS = 'mcp__superpowers-flow__progress'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const TIERS = ['light', 'medium', 'careful', 'heavy', 'fable']

// A long run: 17 planned tasks and 27 workers, as a real plan reaches.
test('pane: a long run still draws on the desktop', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++n}` }))
  on('turn.complete', () => ({ text: '' }) as never)
  const tasks = Array.from({ length: 17 }, (_, i) => ({ title: `Task ${i + 1}: something to build`, tier: TIERS[i % 5], after: i ? [i] : [] }))
  await $.tool.call({ tool: PROGRESS, title: 'User invite and password reset', phase: 'delegate', tasks, done: 9 } as never)
  for (let i = 0; i < 27; i++) {
    await $.agent.spawn({ tool_use_id: `t${i}`, prompt: 'p', description: `Task ${(i % 17) + 1}: something to build`, subagentType: `superpowers-flow:sp-${TIERS[i % 5]}`, provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
    await $.tool.call({ tool: 'mcp__superpowers-flow__step', agentId: `a${i + 1}`, done: 3, total: 6, note: 'writing the report' } as never)
    if (i < 26) await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: `a${i + 1}`, reason: 'answer', answer: 'ok', usage: null })
  }
  await clock.advance(60_000)

  const ui = await $.ui.mount({ plugin: 'superpowers-flow', surface: 'desktop', component: 'Pane', requestId: 'sp-agents', props: pane })
  const size = async () => (await ui.findAll({ type: 'Svg' })).reduce((n, el) => n + String(el.props.source).length, 0)
  // Running 1, finished 8 of 26: header, grid tiles and rows stay well under the size that stopped drawing.
  expect(await ui.find({ key: 'more' })).toBeDefined()
  expect(await size()).toBeLessThan(60_000)

  // "Show more" draws up to 24 finished rows and counts the rest; still bounded.
  await ui.press({ key: 'more' })
  expect(await ui.find({ key: 'fewer' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+2 · /flow-status' })).toBeDefined()
  expect(await size()).toBeLessThan(150_000)
})

// Four child sessions of 30 workers each, five of them running: each row lists its newest
// three running workers and counts the rest, so the pane stays the size it can draw.
test('pane: child sessions with many workers still draw on the desktop', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 28, 10) })
  const files = new Map<string, string>()
  on('process.run', (_$, e) => {
    const { argv } = e as { argv: string[] }
    if (argv.includes('--git-common-dir')) return { value: { exitCode: 0, stdout: '/repo/.git\n', stderr: '' } } as never
    if (argv.includes('--abbrev-ref')) return { value: { exitCode: 0, stdout: 'f\n', stderr: '' } } as never
    return { value: { exitCode: 1, stdout: '', stderr: '' } } as never
  })
  on('fs.write', (_$, e) => (files.set((e as { path: string }).path, (e as { text: string }).text), { value: undefined }) as never)
  on('fs.read', (_$, e) => ({ value: files.get((e as { path: string }).path) ?? '' }) as never)
  on('fs.exists', (_$, e) => ({ value: files.has((e as { path: string }).path) }) as never)
  on('fs.list', (_$, e) => {
    const dir = (e as { path: string }).path + '/'
    return { value: [...files.keys()].filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/')).map(k => ({ name: k.slice(dir.length), kind: 'file', size: 0, mtimeMs: 1, isLink: false })) } as never
  })
  mock.env(on, { LANG: 'en_US.UTF-8' })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('config.list', () => ({ value: [{ key: 'superpowers-flow.runner', label: 'runner', kind: 'choice', value: 'profile', options: ['profile', 'subagent', 'worktree', 'session'], provider: { plugin: 'superpowers-flow', tier: 'user' }, isLocked: false }] }) as never)
  on('config.set', (_$, e) => ({ value: (e as { value: unknown }).value }) as never)
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'flow-config', args: 'runner=session' } as never)
  await $.tool.call({ tool: 'mcp__superpowers-flow__progress', title: 'Big', phase: 'delegate', total: 40 } as never)
  const run = '/repo/.git/superpowers-flow/2026-10-28-f-big'
  const at = clock.now()
  for (const sl of ['a', 'b', 'c', 'd']) {
    const crew = Array.from({ length: 30 }, (_, i) => ({ description: `Task ${i}: a long worker description here`, type: 'superpowers-flow:sp-medium', model: 'claude-opus-5-5', status: i < 25 ? 'done' : 'running', stepDone: 2, stepTotal: 5, stepNote: 'writing tests', costUsd: 0.1, contextTokens: 50000, contextMax: 1_000_000, startedAt: at }))
    files.set(`${run}/${sl}.json`, JSON.stringify({ title: `Slice ${sl}`, done: 3, total: 10, phase: 'delegate', isFinished: false, model: 'claude-opus-5-5', costUsd: 1, startedAt: at, updatedAt: at, tasks: [], crew, running: 3 }))
  }
  await clock.advance(2100)
  const ui = await $.ui.mount({ plugin: 'superpowers-flow', surface: 'desktop', component: 'Pane', requestId: 'sp-agents', props: { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as never })
  const svgs = await ui.findAll({ type: 'Svg' })
  // Grid tiles, header, 4 slice rows and 3 workers under each.
  expect(svgs.filter(el => String(el.props.alt).startsWith('Task ')).length).toBe(12)
  expect(await ui.find({ type: 'Text', text: '   +2 · /flow-status' })).toBeDefined()
  expect(svgs.reduce((n, el) => n + String(el.props.source).length, 0)).toBeLessThan(150_000)
})
