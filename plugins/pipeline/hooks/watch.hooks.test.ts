import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__pipeline__pipeline'
const MAIN = '/p/main'
const WORKTREE = '/p/wt/task-7'
const DIR = `${MAIN}/docs/pipeline`
const CONFIG = `${DIR}/config.json`
const BACKLOG = `${DIR}/backlog.json`
const LIVE = `${MAIN}/.git/pipeline-live.json`
const NOW = Date.parse('2026-11-05T10:00:00Z')
const MIN = 60_000

const config = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, mainBranch: 'main', branch: 'feat/<id>', checks: {}, merge: 'pr', protectedPaths: ['.github/workflows/**'], limits: { fixRounds: 3, silentMinutes: 10, taskMinutes: 45, itemTokens: 4000000 }, notify: 'all', ...extra }, null, 2) + '\n'

type Engine = { tool: { call: (e: never) => Promise<unknown> }; session: { start: (e: never) => Promise<unknown>; end: (e: never) => Promise<unknown> }; agent: { spawn: (e: never) => Promise<unknown> }; turn: { complete: unknown; step: unknown } }

/** A main checkout at /p/main, this session in its worktree, files in memory; records writes, pushes, wake-ups and the plugin's state. */
function world(on: On, seed: Record<string, string> = {}, options: { hasRepo?: boolean; wakeup?: boolean; push?: 'ok' | 'deny'; sessionId?: string } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>(Object.entries(seed))
  const state = new Map<string, unknown>()
  const pushes: string[] = []
  const toasts: string[] = []
  const wakeups: Record<string, unknown>[] = []
  const passed: string[] = []
  // `w.root` is what session.root answers (EnterWorktree moves it).
  const w = { root: WORKTREE }
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
  on('session.repo', () => ({ value: options.hasRepo === false ? null : { root: MAIN, remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: w.root }))
  on('session.cwd', () => ({ value: w.root }))
  on('session.id', () => ({ value: options.sessionId ?? 'self' }))
  on('env.get', (_$, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/home/me' : undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('tool.list', () => ({ value: options.wakeup ? [{ name: 'ScheduleWakeup', description: '', isMcp: false }] : [] }) as never)
  on('state.set', async (_$, e, next) => {
    const r = await next(e)
    const ev = e as { plugin: string; key: string; value: unknown }
    if (ev.plugin === 'pipeline') state.set(ev.key, ev.value)
    return r
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('agent.spawn', (_$, e) => ({ model: 'claude-x', agentId: `agent-${e.tool_use_id}` }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* () {
    return { turnId: 'turn', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'claude-x', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('tool.call', { tool: 'PushNotification' }, (_$, e) => {
    if (options.push === 'deny') return { deny: 'no push here' }
    pushes.push(String((e as { message: string }).message))
    return { result: 'sent' }
  })
  on('tool.call', { tool: 'ScheduleWakeup' }, (_$, e) => {
    wakeups.push(e as unknown as Record<string, unknown>)
    return { result: 'scheduled' }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text: string }).text))
    return { value: undefined } as never
  })
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Bash'] as const) {
    on('tool.call', { tool: tool as 'Edit' }, (_$, e) => {
      passed.push(`${e.tool}:${String((e as { file_path?: string; command?: string }).file_path ?? (e as { command?: string }).command ?? '')}`)
      const cmd = (e as { command?: string }).command ?? ''
      return cmd.includes('fail') ? ({ result: 'exit 1', isError: true } as never) : { result: 'ok' }
    })
  }
  return { clock, files, state, pushes, toasts, wakeups, passed, w }
}

const text = (r: unknown) => String((r as { result: unknown }).result)
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: TOOL, ...input } as never)
const start = ($: Engine) => $.session.start({ cwd: WORKTREE, surface: 'terminal', isInteractive: true } as never)
const spawn = ($: Engine, description: string, n = 1) =>
  $.agent.spawn({ tool_use_id: `t${n}`, prompt: 'p', description, subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-x', background: false, fork: false } as never)
const complete = ($: Engine, e: Record<string, unknown>) => ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', ...e })
const step = async ($: Engine, agentId: string) => {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 'turn', index: 0, model: 'claude-x', messageCount: 1, agentId })
  for await (const _ of stream) void _
}
const got = async ($: Engine) => JSON.parse(text(await call($, { action: 'get' }))) as { signals: Record<string, unknown>[]; resume: unknown; active: unknown }
const live = (files: Map<string, string>) => JSON.parse(files.get(LIVE) ?? '{"sessions":{}}') as { sessions: Record<string, { agents: Record<string, unknown>[]; signals: Record<string, unknown>[]; item?: string; seenAt: string }> }

test('Review Focus 3: silent after the limit, dead after a restart with the live file still listing the agent; get delivers each once', async ($, on) => {
  const backlog = JSON.stringify({ version: 1, items: [{ id: 'p12', title: 'CSV export', status: 'building', ledger: 'docs/pipeline/ledgers/p12.json' }] })
  const ledger = JSON.stringify({ item: 'p12', tasks: [{ n: 1, title: 'a', status: 'running', dispatches: [] }], rulings: [], blockers: [], tokens: 0, resume: { task: 1, state: 'implementer dispatched', lastVerified: 'abc', at: '2026-11-05T09:00:00.000Z' } })
  const { clock, files, state, pushes } = world(on, { [CONFIG]: config(), [BACKLOG]: backlog, [`${DIR}/ledgers/p12.json`]: ledger })
  await start($)
  expect(live(files).sessions['self']).toMatchObject({ item: 'p12', agents: [], signals: [] })

  await spawn($, 'Implement Task 1')
  await step($, 'agent-t1')
  await $.tool.call({ tool: 'Edit', file_path: `${WORKTREE}/src/a.ts`, old_string: 'a', new_string: 'b', agentId: 'agent-t1' } as never)
  expect(state.get('agents')).toMatchObject([{ agentId: 'agent-t1', name: 'Implement Task 1', status: 'running', activity: 'editing a.ts', tokens: 15, calls: 1 }])

  await clock.advance(9 * MIN)
  expect(state.get('signals') ?? []).toEqual([])
  // The ticker refreshed the live file with the running agent and its activity.
  expect(live(files).sessions['self']!.agents).toMatchObject([{ agentId: 'agent-t1', name: 'Implement Task 1', status: 'running', activity: 'editing a.ts', tokens: 15 }])
  expect(pushes).toEqual([])
  await clock.advance(MIN)
  const raised = state.get('signals') as Record<string, unknown>[]
  expect(raised).toHaveLength(1)
  expect(raised[0]).toMatchObject({ kind: 'silent', agent: 'Implement Task 1', agentId: 'agent-t1', delivered: false })
  expect(pushes).toHaveLength(1)
  expect(pushes[0]).toContain('silent')
  expect(pushes[0]).toContain('Implement Task 1')
  await clock.advance(10 * MIN)
  expect(state.get('signals')).toHaveLength(1)
  expect(pushes).toHaveLength(1)
  expect(live(files).sessions['self']!.signals).toHaveLength(1)
  expect(text(await call($, { action: 'status' }))).toContain('Signals\n  silent: Implement Task 1')

  // The session restarts: the live file still lists the agent as running under this session.
  await start($)
  const after = state.get('signals') as Record<string, unknown>[]
  expect(after.map(s => s['kind'])).toEqual(['silent', 'dead'])
  expect(after[1]).toMatchObject({ agentId: 'agent-t1', agent: 'Implement Task 1', delivered: false })
  expect(String(after[1]!['detail'])).toContain('p12')
  expect(live(files).sessions['self']!.agents).toEqual([])
  expect(pushes).toHaveLength(2)

  const first = await got($)
  expect(first.signals.map(s => s['kind'])).toEqual(['silent', 'dead'])
  expect(first.active).toBe('p12')
  expect(first.resume).toMatchObject({ task: 1, state: 'implementer dispatched', lastVerified: 'abc' })
  const second = await got($)
  expect(second.signals).toEqual([])
  expect((state.get('signals') as Record<string, unknown>[]).every(s => s['delivered'] === true)).toBe(true)
  expect(text(await call($, { action: 'status' }))).not.toContain('Signals')
  // Delivered signals are not raised again.
  await clock.advance(30 * MIN)
  expect(state.get('signals')).toHaveLength(2)
})

test('Review Focus 4: a subagent editing a protected path is denied with the rule named; the main session passes', async ($, on) => {
  const { passed } = world(on, { [CONFIG]: config() })
  await start($)
  await spawn($, 'Implement Task 1')
  const path = `${WORKTREE}/.github/workflows/ci.yml`
  const denied = await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', agentId: 'agent-t1' } as never)
  expect(denied).toMatchObject({ deny: `pipeline: ${path} is protected by docs/pipeline/config.json protectedPaths` })
  expect(passed).toEqual([])
  const main = await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' } as never)
  expect(main).toMatchObject({ result: 'ok' })
  expect(passed).toEqual([`Edit:${path}`])
  for (const tool of ['Write', 'MultiEdit']) {
    const r = await $.tool.call({ tool, file_path: `${MAIN}/.github/workflows/deep/x.yml`, agentId: 'agent-t1' } as never)
    expect(r).toMatchObject({ deny: `pipeline: ${MAIN}/.github/workflows/deep/x.yml is protected by docs/pipeline/config.json protectedPaths` })
  }
  const nb = await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${MAIN}/.github/workflows/n.ipynb`, agentId: 'agent-t1' } as never)
  expect(nb).toMatchObject({ deny: `pipeline: ${MAIN}/.github/workflows/n.ipynb is protected by docs/pipeline/config.json protectedPaths` })
  const allowed = await $.tool.call({ tool: 'Edit', file_path: `${WORKTREE}/.github/CODEOWNERS`, old_string: 'a', new_string: 'b', agentId: 'agent-t1' } as never)
  expect(allowed).toMatchObject({ result: 'ok' })
  const read = await $.tool.call({ tool: 'Read', file_path: path, agentId: 'agent-t1' } as never)
  expect(read).toMatchObject({ result: 'ok' })
})

test('a subagent failing the same command three times raises looping once; turn.complete marks it done', async ($, on) => {
  const { clock, state, files, pushes } = world(on, { [CONFIG]: config() })
  await start($)
  await spawn($, 'Implement Task 2')
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test -- fail', agentId: 'agent-t1' } as never)
  expect(state.get('agents')).toMatchObject([{ failures: 3, lastCommands: ['npm test -- fail', 'npm test -- fail', 'npm test -- fail'], activity: 'running npm test' }])
  await clock.advance(30_000)
  expect((state.get('signals') as Record<string, unknown>[]).map(s => s['kind'])).toEqual(['looping'])
  expect(pushes).toHaveLength(1)
  await clock.advance(30_000)
  expect(state.get('signals')).toHaveLength(1)
  await complete($, { agentId: 'agent-t1' })
  expect(state.get('agents')).toMatchObject([{ status: 'done' }])
  expect(live(files).sessions['self']!.agents).toEqual([])
  await complete($, { agentId: 'agent-t1', reason: 'error' })
  expect(state.get('agents')).toMatchObject([{ status: 'done' }])
})

test('notify off sends nothing; a failing push falls back to a toast', async ($, on) => {
  const { clock, pushes, toasts } = world(on, { [CONFIG]: config({ notify: 'off' }) })
  await start($)
  await spawn($, 'Quiet one')
  await clock.advance(10 * MIN)
  expect(pushes).toEqual([])
  expect(toasts).toEqual([])
})

test('a push that fails becomes a toast', async ($, on) => {
  const { clock, toasts, pushes } = world(on, { [CONFIG]: config({ notify: 'milestones' }) }, { push: 'deny' })
  await start($)
  await spawn($, 'Toasted')
  await clock.advance(10 * MIN)
  expect(pushes).toEqual([])
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('Toasted')
})

test('wake-up: one ScheduleWakeup while an agent runs, never two pending, none when nothing runs or the tool is missing', async ($, on) => {
  const { clock, wakeups } = world(on, { [CONFIG]: config() }, { wakeup: true })
  await start($)
  await complete($, {})
  expect(wakeups).toEqual([])
  await spawn($, 'Implement Task 1')
  await complete($, {})
  expect(wakeups).toHaveLength(1)
  expect(wakeups[0]).toMatchObject({ delaySeconds: 600, prompt: 'pipeline: check the watchdog signals with the pipeline tool' })
  await complete($, {})
  expect(wakeups).toHaveLength(1)
  await clock.advance(10 * MIN + 1000)
  await complete($, {})
  expect(wakeups).toHaveLength(2)
  await complete($, { agentId: 'agent-t1' })
  await clock.advance(11 * MIN)
  await complete($, {})
  expect(wakeups).toHaveLength(2)
})

test('without the tool no wake-up is asked for', async ($, on) => {
  const { wakeups } = world(on, { [CONFIG]: config() })
  await start($)
  await spawn($, 'Implement Task 1')
  await complete($, {})
  expect(wakeups).toEqual([])
})

test('session.end removes this session from the live file and keeps the others', async ($, on) => {
  const other = { title: 'other', cwd: '/p/x', startedAt: '2026-11-05T09:00:00.000Z', seenAt: '2026-11-05T09:59:50.000Z', agents: [], signals: [] }
  const { files } = world(on, { [CONFIG]: config(), [LIVE]: JSON.stringify({ sessions: { other } }) })
  await start($)
  expect(Object.keys(live(files).sessions)).toEqual(['other', 'self'])
  await $.session.end({ reason: 'other', sessionId: 'self' } as never)
  expect(Object.keys(live(files).sessions)).toEqual(['other'])
  expect(files.get(LIVE)?.endsWith('\n')).toBe(true)
})

test('a fresh other session with a running agent is alive, not dead', async ($, on) => {
  const agent = { id: 't9', agentId: 'a9', name: 'Theirs', model: 'm', status: 'running', startedAt: NOW - MIN, lastStepAt: NOW - MIN, calls: 0, tokens: 0, activity: 'starting', lastCommands: [], failures: 0 }
  const other = { title: 'other', cwd: '/p/x', startedAt: '2026-11-05T09:00:00.000Z', seenAt: new Date(NOW - 20_000).toISOString(), agents: [agent], signals: [] }
  const { files, state } = world(on, { [CONFIG]: config(), [LIVE]: JSON.stringify({ sessions: { other } }) })
  await start($)
  expect(state.get('signals') ?? []).toEqual([])
  expect(live(files).sessions['other']!.agents).toHaveLength(1)
})

test('without a repository the live file is under ~/.claude/pipeline named by the root hash', async ($, on) => {
  const { files } = world(on, {}, { hasRepo: false })
  await start($)
  const written = [...files.keys()].filter(p => p.startsWith('/home/me/.claude/pipeline/'))
  expect(written).toHaveLength(1)
  expect(written[0]).toMatch(/^\/home\/me\/\.claude\/pipeline\/[0-9a-f]{12}\.json$/)
})

const edit = ($: Engine, file_path: string, agentId?: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) } as never)

test('C2: a protected path in a worktree the lead entered after session start is denied', async ($, on) => {
  const { passed, w } = world(on, { [CONFIG]: config() })
  await start($)
  w.root = `${MAIN}/.claude/worktrees/p12` // EnterWorktree: session.root now answers the worktree
  await spawn($, 'Implement Task 1')
  const r = await edit($, `${MAIN}/.claude/worktrees/p12/.github/workflows/ci.yml`, 'agent-t1')
  expect(r).toMatchObject({ deny: expect.stringContaining('protected') })
  // A worktree elsewhere, not under the main checkout, is matched through the root read at call time.
  w.root = '/elsewhere/wt'
  const r2 = await edit($, '/elsewhere/wt/.github/workflows/ci.yml', 'agent-t1')
  expect(r2).toMatchObject({ deny: expect.stringContaining('protected') })
  expect(passed).toEqual([])
})

test('I1: a protected path reached through .. or a relative path is denied', async ($, on) => {
  const { passed } = world(on, { [CONFIG]: config() })
  await start($)
  await spawn($, 'Implement Task 1')
  expect(await edit($, `${MAIN}/src/../.github/workflows/ci.yml`, 'agent-t1')).toMatchObject({ deny: expect.stringContaining('protected') })
  expect(await edit($, '.github/workflows/./ci.yml', 'agent-t1')).toMatchObject({ deny: expect.stringContaining('protected') })
  expect(await edit($, `${WORKTREE}/.github/../src/a.ts`, 'agent-t1')).toMatchObject({ result: 'ok' })
  expect(passed).toEqual([`Edit:${WORKTREE}/.github/../src/a.ts`])
})

test('I2: an entry that died under STALE_MS before a new session started is reported dead by the ticker, once', async ($, on) => {
  const agent = { id: 't1', agentId: 'agent-t1', name: 'Implement Task 3', model: 'm', status: 'running', startedAt: NOW - 5 * MIN, lastStepAt: NOW - 2 * MIN, calls: 3, tokens: 0, activity: 'editing a.ts', lastCommands: [], failures: 0 }
  const old = { title: 'p12 · x', cwd: WORKTREE, item: 'p12', startedAt: new Date(NOW - 30 * MIN).toISOString(), seenAt: new Date(NOW - MIN).toISOString(), agents: [agent], signals: [] }
  const { clock, state, files, pushes } = world(on, { [CONFIG]: config(), [LIVE]: JSON.stringify({ sessions: { old } }) }, { sessionId: 'new' })
  await start($)
  // Not stale yet: the old entry is left alone.
  expect(state.get('signals') ?? []).toEqual([])
  expect(Object.keys(live(files).sessions)).toEqual(['old', 'new'])
  await clock.advance(2 * MIN)
  expect(state.get('signals') ?? []).toEqual([])
  await clock.advance(20 * MIN)
  const raised = state.get('signals') as Record<string, unknown>[]
  expect(raised).toHaveLength(1)
  expect(raised[0]).toMatchObject({ kind: 'dead', agentId: 'agent-t1', agent: 'Implement Task 3', delivered: false })
  expect(String(raised[0]!['detail'])).toContain('p12')
  expect(pushes).toHaveLength(1)
  expect(Object.keys(live(files).sessions)).toEqual(['new'])
  const r = await got($)
  expect(r.signals.map(s => s['kind'])).toEqual(['dead'])
  await clock.advance(20 * MIN)
  expect(state.get('signals')).toHaveLength(1)
})

test('I3: the undelivered silent signal in the live file survives a process restart', async ($, on) => {
  // The previous instance raised silent at 09:50 and never delivered it; its entry is stale by the time this one starts.
  const agent = { id: 't1', agentId: 'agent-t1', name: 'Implement Task 1', model: 'm', status: 'running', startedAt: NOW - 25 * MIN, lastStepAt: NOW - 20 * MIN, calls: 3, tokens: 15, activity: 'editing a.ts', lastCommands: [], failures: 0 }
  const silent = { kind: 'silent', agent: 'Implement Task 1', agentId: 'agent-t1', detail: 'no step or tool call for 10 min', at: NOW - 10 * MIN, delivered: false }
  const old = { title: 'p12 · x', cwd: WORKTREE, item: 'p12', startedAt: new Date(NOW - 30 * MIN).toISOString(), seenAt: new Date(NOW - 5 * MIN).toISOString(), agents: [agent], signals: [silent] }
  const { clock, files, state, pushes } = world(on, { [CONFIG]: config(), [LIVE]: JSON.stringify({ sessions: { old } }) }, { sessionId: 'new' })
  await start($)
  const after = state.get('signals') as Record<string, unknown>[]
  expect(after.map(s => [s['kind'], s['delivered']])).toEqual([
    ['silent', false],
    ['dead', false],
  ])
  expect(after[0]).toMatchObject({ agentId: 'agent-t1', agent: 'Implement Task 1', at: NOW - 10 * MIN, detail: 'no step or tool call for 10 min' })
  expect(after[1]).toMatchObject({ agentId: 'agent-t1', agent: 'Implement Task 1' })
  expect(String(after[1]!['detail'])).toContain('p12')
  expect(Object.keys(live(files).sessions)).toEqual(['new'])
  // The restored signal is not announced again; the dead one is.
  expect(pushes).toHaveLength(1)
  expect(pushes[0]).toContain('dead')
  const r = await got($)
  expect(r.signals.map(s => s['kind'])).toEqual(['silent', 'dead'])
  expect(r.signals[0]).toMatchObject({ kind: 'silent', agentId: 'agent-t1', at: NOW - 10 * MIN })
  expect((await got($)).signals).toEqual([])
  expect(live(files).sessions['new']!.signals.every(s => s['delivered'] === true)).toBe(true)
  // A restart with the state kept (the same instance) doubles nothing, and the ticker raises neither again.
  await start($)
  expect(state.get('signals')).toHaveLength(2)
  await clock.advance(20 * MIN)
  expect(state.get('signals')).toHaveLength(2)
  expect(pushes).toHaveLength(1)
})

test('a long tool call is a sign of life: silent is not raised while or right after one shell command', async ($, on) => {
  const { clock, state } = world(on, { [CONFIG]: config() })
  await start($)
  await spawn($, 'Implement Task 1')
  await step($, 'agent-t1')
  await clock.advance(8 * MIN)
  // The call starts at 8 min and, through the mock, returns at once; the clock then moves 9 more minutes.
  await $.tool.call({ tool: 'Bash', command: 'npm run build', agentId: 'agent-t1' } as never)
  await clock.advance(9 * MIN)
  expect(state.get('signals') ?? []).toEqual([])
  await clock.advance(MIN)
  const raised = state.get('signals') as Record<string, unknown>[]
  expect(raised.map(s => s['kind'])).toEqual(['silent'])
  expect(String(raised[0]!['detail'])).toContain('no step or tool call for 10 min')
  expect(String(raised[0]!['detail'])).toContain('running npm run build')
})
