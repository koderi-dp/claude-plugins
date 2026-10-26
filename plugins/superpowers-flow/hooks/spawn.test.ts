import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'superpowers-flow'
const STEP = 'mcp__superpowers-flow__step'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

const spawn = { tool_use_id: 't1', prompt: 'Do the task.', description: 'Wire the CLI', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as const

// Superpowers dispatches general-purpose agents: they get the step request too, so
// the panel draws their own progress instead of the grey context bar.
test('spawn: every subagent brief ends with the step request', async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const prompts: string[] = []
  on('agent.spawn', (_$, e) => {
    prompts.push(e.prompt)
    return { model: 'claude-opus-5-5', agentId: 'a1' }
  })
  await $.agent.spawn({ ...spawn, subagentType: 'general-purpose' } as never)
  await $.agent.spawn({ ...spawn, tool_use_id: 't2', subagentType: 'superpowers-flow:sp-light', prompt: `Already asked: ${STEP}` } as never)

  expect(prompts[0]).toContain(`call \`${STEP}\``)
  // A brief that already asks is left alone.
  expect(prompts[1]).toBe(`Already asked: ${STEP}`)
})

// The tier is read off the agent name, with or without the plugin prefix.
test('spawn: an sp-* worker shows its tier, anything else its type', async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++n}` }))
  await $.agent.spawn({ ...spawn, subagentType: 'superpowers-flow:sp-careful' } as never)
  await $.agent.spawn({ ...spawn, tool_use_id: 't2', description: 'Scout', subagentType: 'general-purpose' } as never)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'sp-agents', props: pane })
  expect(await ui.find({ type: 'Text', text: /careful · Opus 5\.5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /general-purpose · Opus 5\.5/ })).toBeDefined()
})

// A worker's step report lands on its own row.
test('spawn: a step report draws on the worker row', async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  await $.agent.spawn({ ...spawn, subagentType: 'sp-medium' } as never)

  expect(await $.tool.call({ tool: STEP, agentId: 'a1', done: 2, total: 5, note: 'tests' } as never)).toMatchObject({ result: 'ok' })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'sp-agents', props: pane })
  expect(await ui.find({ type: 'Text', text: /2\/5 tests/ })).toBeDefined()
})
