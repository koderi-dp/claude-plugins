import { expect, mock, test } from 'claude-code/testing'

const PROGRESS = 'mcp__superpowers-flow__progress'
const spawn = { tool_use_id: 't1', prompt: 'p', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as const

const plan = {
  tool: PROGRESS,
  title: 'Ship it',
  phase: 'delegate',
  tasks: [
    { title: 'Write the parser', tier: 'careful' },
    { title: 'Wire the CLI', tier: 'light', after: [1] },
  ],
} as const

// The panel as text: one worker running on the first task, the second still planned.
test('/flow-status answers with the plan, the agents and the planned tasks', async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  await $.tool.call(plan as never)
  await $.agent.spawn({ ...spawn, description: 'Write the parser', subagentType: 'superpowers-flow:sp-careful' } as never)
  await $.tool.call({ tool: 'mcp__superpowers-flow__step', agentId: 'a1', done: 1, total: 4, note: 'tests' } as never)

  const out = await $.command.run({ command: 'flow-status', args: '' } as never)
  const text = String((out as { text?: string }).text)
  expect(text).toContain('Ship it · Tasks 0/2 · 0%')
  expect(text).toContain('Running · 1')
  expect(text).toContain('● Write the parser  ·  careful · Opus 5.5 · 1/4 tests')
  expect(text).toContain('Planned · 1')
  expect(text).toContain('◷ 2. Wire the CLI  ·  light · Opus · low · after 1')
})

test('/flow-status before any flow says so', async ($, on) => {
  mock.clock(on)
  const out = await $.command.run({ command: 'flow-status', args: '' } as never)
  expect((out as { text?: string }).text).toContain('No subagents yet.')
})
