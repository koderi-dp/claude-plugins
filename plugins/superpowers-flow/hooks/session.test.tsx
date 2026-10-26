import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'superpowers-flow'
const PROGRESS = 'mcp__superpowers-flow__progress'
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never } as const

// One answered turn of the main session, at $0.50 of a $1.25 total and 42% context.
async function turn($: Engine, on: On) {
  mock.clock(on, { now: Date.parse('2026-10-26T10:00:00Z') })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let usd = 0.75
  on('session.usage', async () => ({ value: { cost: { usd }, context: { percent: 42 } } }) as never)
  on('turn.start', () => ({ turnId: 'turn' }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 'turn' })
  usd = 1.25
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', usage: null })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the session row draws without a flow`, async ($, on) => {
    await turn($, on)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\$0\.50$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\$1\.25$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^60:00$/ })).toBeDefined()
  })

  test(`${surface}: the flow row and the session row draw together`, async ($, on) => {
    await turn($, on)
    await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 4, done: 1, phase: 'delegate' } as never)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await ui.find({ key: 'sp-agents' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\$1\.25$/ })).toBeDefined()
  })
}

test('/flow-session hides the session row and shows it again', async ($, on) => {
  await turn($, on)
  // With a flow reported the band keeps drawing while the session row is hidden.
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 4, done: 1, phase: 'delegate' } as never)
  const shows = () => $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND }).then(u => u.find({ key: 'hide-session' }))
  expect(await shows()).toBeDefined()
  expect(await $.command.run({ command: 'flow-session', args: '' } as never)).toMatchObject({ text: 'Session row hidden.' })
  expect(await shows()).toBeUndefined()
  expect(await $.command.run({ command: 'flow-session', args: '' } as never)).toMatchObject({ text: 'Session row shown.' })
  expect(await shows()).toBeDefined()
})
