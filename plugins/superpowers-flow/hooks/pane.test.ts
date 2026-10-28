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
