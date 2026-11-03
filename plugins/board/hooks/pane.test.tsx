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

const USAGE_TEXT = 'board: status | status all | status <id> | show <id> | find <text> | init | open'

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

const BOARD = `${MAIN}/docs/superpowers/board.json`
const LIVE = `${MAIN}/.git/board-live.json`
const item = (id: string, title: string, status: string, extra: object = {}) => ({ id, title, status, ...extra })
const big = {
  version: 1,
  milestones: [
    { id: 'a', title: 'Phase 1 Foundation', status: 'active', items: [item('t1', 'Monorepo', 'done'), item('t2', 'Domain package', 'in_progress'), item('t3', 'Paraglide UI', 'blocked', { note: 'WIP commit on task-7' })] },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, title: `Planned ${i}`, status: 'planned', needs: i === 0 ? ['a'] : undefined, size: 'M', items: [item('t1', `Thing ${i}`, 'backlog')] })),
    { id: 'd1', title: 'Old one', status: 'done', items: [item('t1', 'x', 'done')] },
    { id: 'd2', title: 'Webhook corpus', status: 'done', items: [item('t1', 'y', 'done')] },
  ],
}

test('home groups milestones, folds planned after 4 and opens one on press', async ($, on) => {
  world(on, { [BOARD]: JSON.stringify(big) })
  await run($, 'open')
  const ui = await $.ui.mount({ plugin: 'board', surface: 'terminal', component: 'Pane', requestId: 'board', props: PANE })
  expect(await ui.find({ type: 'Text', text: /3\/11 items/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Active' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 done, latest: Webhook corpus/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 blocked: WIP commit on task-7/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /needs a · M/ })).toBeDefined()
  expect(await ui.find({ key: 'm-p4' })).toBeUndefined()
  await ui.press({ key: 'more' })
  expect(await ui.find({ key: 'm-p5' })).toBeDefined()
  await ui.press({ key: 'm-a' })
  expect(await ui.find({ key: 'back' })).toBeDefined()
  for (const t of ['Monorepo', 'Domain package', 'Paraglide UI']) expect(await ui.find({ type: 'Text', text: new RegExp(t) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Blocked' })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'm-a' })).toBeDefined()
  await ui.press({ key: 'now' })
  expect(await ui.find({ type: 'Text', text: /Nothing running/ })).toBeDefined()
})

test('a milestone view names the session holding an item and lists what it closes', async ($, on) => {
  const at = '2026-11-02T09:59:00.000Z'
  const q8 = { version: 1, milestones: [{ id: 'q8', title: 'Thread following', status: 'active', ref: 'docs/superpowers/plans/q8.md', branch: 'feat/q8', closes: ['18 Thread following'], items: [item('t1', 'Follow a thread', 'done', { note: 'a3f91c2..b70de44' }), item('t2', 'Threads I follow view', 'in_progress', { updatedAt: '2026-11-02T09:48:00Z' }), item('t3', 'Thread mute', 'backlog')] }] }
  const liveFile = { sessions: { s1: { title: 'Implement Q8 threads', cwd: 'C:/wt/q8', item: 'q8/t2', startedAt: at, seenAt: at, agents: [] } } }
  world(on, { [BOARD]: JSON.stringify(q8), [LIVE]: JSON.stringify(liveFile) })
  expect(await run($, 'show q8')).toBe('Board panel shows q8.')
  const ui = await $.ui.mount({ plugin: 'board', surface: 'desktop', component: 'Pane', requestId: 'board', props: PANE })
  expect(await ui.find({ type: 'Text', text: /Threads I follow view · Implement Q8 threads/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '12m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'a3f91c2..b70de44' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /18 Thread following/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /docs\/superpowers\/plans\/q8\.md · feat\/q8/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Backlog' })).toBeDefined()
  expect(await run($, 'show zz')).toMatch(/^No milestone zz/)
})

test('/board find lists matches with their milestone', async ($, on) => {
  world(on, { [BOARD]: JSON.stringify(big) })
  expect(await run($, 'find paraglide')).toBe('a · t3 · Paraglide UI · blocked')
  expect(await run($, 'find')).toBe(USAGE_TEXT)
})

test('with no board the pane is the Now view without a back button, and find says so', async ($, on) => {
  world(on)
  await run($, 'open')
  const ui = await $.ui.mount({ plugin: 'board', surface: 'terminal', component: 'Pane', requestId: 'board', props: PANE })
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Nothing running/ })).toBeDefined()
  expect(await run($, 'find x')).toBe('No board.')
})

test('a board file that does not parse shows its error line in the pane', async ($, on) => {
  world(on, { [BOARD]: '{\n  "version": 1,\n  "milestones": [\n' })
  await run($, 'open')
  const ui = await $.ui.mount({ plugin: 'board', surface: 'terminal', component: 'Pane', requestId: 'board', props: PANE })
  expect(await ui.find({ type: 'Text', text: /^Board: line \d+: / })).toBeDefined()
})

test("another session's board change reaches the open panel", async ($, on) => {
  const w = world(on, { [BOARD]: JSON.stringify({ version: 1, milestones: [{ id: 'a', title: 'First', status: 'active', items: [] }] }) })
  await $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true } as never)
  await run($, 'open')
  const ui = await $.ui.mount({ plugin: 'board', surface: 'terminal', component: 'Pane', requestId: 'board', props: PANE })
  expect(await ui.find({ key: 'm-a' })).toBeDefined()
  w.files.set(BOARD, JSON.stringify({ version: 1, milestones: [{ id: 'b', title: 'Second', status: 'active', items: [] }] }))
  await w.clock.advance(6000)
  expect(await ui.find({ key: 'm-b' })).toBeDefined()
})
