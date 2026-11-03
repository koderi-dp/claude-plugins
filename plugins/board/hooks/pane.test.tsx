import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = { title: 'Board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const MAIN = 'C:/p/main'

function world(on: On, seed: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: Date.parse('2026-11-02T10:00:00Z') })
  const files = new Map<string, string>(Object.entries(seed))
  const key = (p: string) => p.split(String.fromCharCode(92)).join('/')
  const panes: string[] = []
  const opened: string[] = []
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
  on('ui.panes', () => ({ value: panes.map(id => ({ id, title: 'Board', isPlaced: true })) }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.repo', () => ({ value: { root: MAIN, remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: MAIN }))
  on('session.cwd', () => ({ value: MAIN }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }) as never)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++n}` }))
  let t = 0
  on('tool.call', (_$, e) => (e.tool === 'TaskCreate' ? { result: `Task #${++t} created successfully` } : { result: 'ok' }) as never)
  return { clock, files, panes, opened }
}

const spawn = (description: string) =>
  ({ tool_use_id: `tu-${description}`, prompt: 'p', description, subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false }) as never

const run = async ($: { command: { run: (e: never) => Promise<unknown> } }, args: string) =>
  ((await $.command.run({ command: 'board', args, origin: { kind: 'composer' } } as never)) as { text?: string }).text ?? ''

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the Now view draws an agent with its activity and a task`, async ($, on) => {
    world(on)
    await $.agent.spawn(spawn('Implement Task 2'))
    await $.tool.call({ tool: 'Read', file_path: 'C:/p/progress.md', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'TaskCreate', subject: 'Write the parser', description: 'd' } as never)
    const ui = await $.ui.mount({ plugin: 'board', surface, component: 'Pane', requestId: 'board', props: PANE })
    expect(await ui.find({ type: 'Text', text: /Implement Task 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /reading progress\.md/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Write the parser/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Agents · 1 running/ })).toBeDefined()
  })

  test(`${surface}: an empty Now view says nothing runs`, async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ plugin: 'board', surface, component: 'Pane', requestId: 'board', props: PANE })
    expect(await ui.find({ type: 'Text', text: 'Nothing running. /board status prints this as text.' })).toBeDefined()
  })
}

test('/board toggles the pane and /board status prints text', async ($, on) => {
  const w = world(on)
  await run($, '')
  expect(w.panes).toEqual(['board'])
  await run($, '')
  expect(w.panes).toEqual([])
  await run($, 'open')
  expect(w.panes).toEqual(['board'])
  const text = await run($, 'status')
  expect(text).toStartWith('No board.')
  expect(text).toContain('Now')
  expect(await run($, 'what')).toBe('board: status | status all | status <id> | show <id> | find <text> | init | open')
})

test('a subagent starting opens the panel once', async ($, on) => {
  const w = world(on)
  await $.agent.spawn(spawn('One'))
  await $.agent.spawn(spawn('Two'))
  expect(w.opened).toEqual(['board'])
})

test('finished agents fold after 8', async ($, on) => {
  world(on)
  for (let i = 1; i <= 10; i++) {
    await $.agent.spawn(spawn(`Agent ${i}`))
    await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: `a${i}`, reason: 'answer', answer: 'ok', usage: null })
  }
  const ui = await $.ui.mount({ plugin: 'board', surface: 'terminal', component: 'Pane', requestId: 'board', props: PANE })
  expect(await ui.find({ type: 'Text', text: /Agent 10/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Agent 2$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '+2 · /board status' })).toBeDefined()
})
