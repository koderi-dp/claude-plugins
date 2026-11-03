import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The test engine has no `$.state`; what the mod holds is read back through `/board status`.

function world(on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-11-02T10:00:00Z') })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', () => ({ value: undefined }))
  on('session.repo', () => ({ value: { root: 'C:/p/main', remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: 'C:/p/main' }))
  on('session.cwd', () => ({ value: 'C:/p/main' }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', () => ({ value: undefined }))
  return clock
}

const spawn = (description: string) => ({
  tool_use_id: `tu-${description}`,
  prompt: 'p',
  description,
  subagentType: 'general-purpose',
  provider: 'engine',
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
})

async function status($: { command: { run: (e: never) => Promise<unknown> } }, args = 'status'): Promise<string> {
  const r = (await $.command.run({ command: 'board', args, origin: { kind: 'composer' } } as never)) as { text?: string }
  return r.text ?? ''
}

test('a subagent gets an activity line from its tool calls and finishes on turn.complete', async ($, on) => {
  const clock = world(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.agent.spawn(spawn('Implement Task 2') as never)
  await $.tool.call({ tool: 'Read', file_path: 'C:/p/progress.md', agentId: 'a1' } as never)
  await clock.advance(90_000)
  expect(await status($)).toContain('  ● Implement Task 2 · opus · 1m · reading progress.md')
  await $.tool.call({ tool: 'Bash', command: 'cd x && npm test', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'other' } as never)
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: 'a1', reason: 'answer', answer: 'ok', usage: null })
  expect(await status($)).toContain('  ✓ Implement Task 2 · 1m · 2 calls')
})

test('a subagent that ends on anything but an answer is failed', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a2' }))
  on('turn.complete', () => ({ text: '' }) as never)
  await $.agent.spawn(spawn('Review') as never)
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: 'a2', reason: 'aborted', usage: null })
  expect(await status($)).toContain('  ✗ Review · 0s · 0 calls')
})

test('TaskCreate and TaskUpdate keep the native task list', async ($, on) => {
  world(on)
  let n = 0
  on('tool.call', (_$, e) =>
    (e.tool === 'TaskCreate' ? { result: `Task #${++n} created successfully: ${(e as unknown as { subject: string }).subject}` } : { result: 'ok' }) as never,
  )
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the parser', description: 'd' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Wire the CLI', description: 'd' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Ship it', description: 'd' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'completed' } as never)
  expect(await status($)).toContain('  tasks: 1 in progress, 1 completed')
})

test('a subagent creating tasks does not touch the session task list', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: 'Task #1 created successfully: x' }) as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'x', description: 'd', agentId: 'a9' } as never)
  expect(await status($)).not.toContain('tasks:')
})
