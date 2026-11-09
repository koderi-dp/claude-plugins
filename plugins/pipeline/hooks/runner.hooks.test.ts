import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__pipeline__pipeline'
const MAIN = '/p/main'
const DIR = `${MAIN}/docs/pipeline`
const CONFIG = `${DIR}/config.json`
const BACKLOG = `${DIR}/backlog.json`
const LIVE = `${MAIN}/.git/pipeline-live.json`
const LOG = `${MAIN}/.git/pipeline/p12.log`
const WORKTREE = `${MAIN}/.claude/worktrees/p12`
const NOW = Date.parse('2026-11-09T10:00:00Z')
const MIN = 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const config = (extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, mainBranch: 'main', branch: 'feat/<id>', checks: {}, merge: 'pr', runner: 'session', notify: 'all', ...extra }, null, 2) + '\n'
const item = (id: string, title: string, status: string, extra: Record<string, unknown> = {}) => ({ id, title, status, size: 'M', updatedAt: '2026-11-09T09:00:00Z', ...extra })
const backlogOf = (items: Record<string, unknown>[]) => JSON.stringify({ version: 1, items }, null, 2) + '\n'
const READY = backlogOf([item('p12', 'CSV export', 'ready'), item('p13', 'Second', 'ready'), item('p14', 'Third', 'inbox')])
// A ready item has a spec without an open question; without one the tool settles it back to inbox on the next write.
const SPECS = { [`${DIR}/specs/p12.md`]: '## What\n\nx\n', [`${DIR}/specs/p13.md`]: '## What\n\nx\n', [`${DIR}/specs/p15.md`]: '## What\n\nx\n' }

type Chunk = { stream: 'stdout' | 'stderr'; text: string }
type End = { code: number | null; signal: string | null }
type Fake = { request: { argv: string[]; cwd?: string; env?: Record<string, string> }; queue: Chunk[]; end: End | null; wake: (() => void) | null; returned: boolean }

type Engine = {
  tool: { call: (e: never) => Promise<unknown> }
  session: { start: (e: never) => Promise<unknown> }
  agent: { spawn: (e: never) => Promise<unknown> }
  command: { run: (e: never) => Promise<unknown> }
  classic: { UserPromptSubmit: (e: never) => Promise<unknown> }
}

/** A main checkout at /p/main, files in memory, git and the child processes faked; records writes, runs, toasts and the plugin's state. */
function world(on: On, seed: Record<string, string> = {}, options: { worktreeAdd?: 'ok' | 'branch-exists' | 'fail'; wakeup?: boolean; env?: Record<string, string>; cwd?: string; children?: Child[] } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>(Object.entries(seed))
  const writes: string[] = []
  const state = new Map<string, unknown>()
  const runs: string[][] = []
  const toasts: string[] = []
  const pushes: string[] = []
  const wakeups: Record<string, unknown>[] = []
  const spawned: Fake[] = []
  const key = (p: string) => p.split(String.fromCharCode(92)).join('/')
  const under = (dir: string) => [...files.keys()].filter(k => k.startsWith(`${dir}/`))
  on('fs.exists', (_$, e) => {
    const p = key(e.path)
    return { value: files.has(p) || under(p).length > 0 }
  })
  on('fs.read', (_$, e) => {
    const t = files.get(key(e.path))
    return t === undefined ? { deny: `ENOENT: ${e.path}` } : { value: t }
  })
  on('fs.write', (_$, e) => {
    files.set(key(e.path), e.text)
    writes.push(key(e.path))
    return { value: undefined }
  })
  on('session.repo', () => ({ value: { root: MAIN, remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: options.cwd ?? MAIN }))
  on('session.cwd', () => ({ value: options.cwd ?? MAIN }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', (_$, e) => ({ value: options.env?.[e.name] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('tool.list', () => ({ value: options.wakeup ? [{ name: 'ScheduleWakeup', description: '', isMcp: false }] : [] }) as never)
  // Children a life before this one left in the state (the state survives a reload, the module's processes do not).
  if (options.children) {
    on('state.get', { plugin: 'pipeline', key: 'children' }, async (_$, e, next) => {
      const r = (await next(e)) as { value?: { value?: unknown; version: number } }
      const held = r.value
      return held && held.value === undefined && !state.has('children') ? ({ value: { ...held, value: options.children } } as never) : (r as never)
    })
  }
  on('state.set', async (_$, e, next) => {
    const r = await next(e)
    const ev = e as { plugin: string; key: string; value: unknown }
    if (ev.plugin === 'pipeline') state.set(ev.key, ev.value)
    return r
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('agent.spawn', (_$, e) => ({ model: 'claude-x', agentId: `agent-${e.tool_use_id}` }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text: string }).text))
    return { value: undefined } as never
  })
  on('tool.call', { tool: 'PushNotification' }, (_$, e) => {
    pushes.push(String((e as { message: string }).message))
    return { result: 'sent' }
  })
  on('tool.call', { tool: 'ScheduleWakeup' }, (_$, e) => {
    wakeups.push(e as unknown as Record<string, unknown>)
    return { result: 'scheduled' }
  })
  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })
  // The classic prompt event the mod reads the permission mode from: nothing of the engine runs under a test.
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('process.run', (_$, e) => {
    const argv = [...(e as { argv: readonly string[] }).argv]
    runs.push(argv)
    const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (argv[0] === 'git' && argv[1] === 'worktree') {
      const mode = options.worktreeAdd ?? 'ok'
      if (mode === 'fail') return { value: { ...ok, exitCode: 128, stderr: 'fatal: not a git repository' } } as never
      if (mode === 'branch-exists' && argv.includes('-b')) return { value: { ...ok, exitCode: 128, stderr: "fatal: a branch named 'feat/p12' already exists" } } as never
      files.set(`${argv[3]}/.git`, 'gitdir: x')
      return { value: ok } as never
    }
    return { value: { ...ok, exitCode: 1, stderr: 'unknown command' } } as never
  })
  // Each spawned child: its chunks arrive as the test emits them, its exit as the test ends it.
  on('process.spawn', async function* (_$, e) {
    const fake: Fake = { request: e as unknown as Fake['request'], queue: [], end: null, wake: null, returned: false }
    spawned.push(fake)
    try {
      for (;;) {
        while (fake.queue.length) yield fake.queue.shift()!
        if (fake.end) return { value: fake.end } as never
        await new Promise<void>(resolve => {
          fake.wake = resolve
        })
      }
    } finally {
      // The stream was left (the parent's return(), or the end): the engine would kill the child here.
      fake.returned = true
    }
  })
  const poke = (f: Fake) => {
    const w = f.wake
    f.wake = null
    w?.()
  }
  const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
    await clock.advance(1)
    for (let i = 0; i < 30; i++) await Promise.resolve()
  }
  const emit = async (text: string, n = 0, stream: 'stdout' | 'stderr' = 'stdout') => {
    const f = spawned[n]!
    f.queue.push({ stream, text })
    poke(f)
    await settle()
  }
  const exit = async (code: number | null, n = 0, signal: string | null = null) => {
    const f = spawned[n]!
    f.end = { code, signal }
    poke(f)
    await settle()
  }
  return { clock, files, writes, state, runs, toasts, pushes, wakeups, spawned, submitted, emit, exit, settle }
}

const text = (r: unknown) => String((r as { result: unknown }).result)
const call = async ($: Engine, input: Record<string, unknown>) => text(await $.tool.call({ tool: TOOL, ...input } as never))
const start = ($: Engine) => $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true } as never)
const mode = ($: Engine, permission_mode: string) => $.classic.UserPromptSubmit({ prompt: 'hi', permission_mode } as never)
const items = (files: Map<string, string>) => JSON.parse(files.get(BACKLOG)!).items as Record<string, unknown>[]
const itemOf = (files: Map<string, string>, id: string) => items(files).find(i => i['id'] === id)!
type Child = { id: string; item: string; status: string; worktree: string; branch: string; log: string; lastLine?: string; endedAt?: number }
const children = (state: Map<string, unknown>) => (state.get('children') ?? []) as Child[]
const assistant = (t: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })

test('start refuses: runner subagent, a permission mode that asks, an item that is not ready, an unknown item', async ($, on) => {
  const { files, spawned, writes } = world(on, { [CONFIG]: config({ runner: 'subagent' }), [BACKLOG]: READY, ...SPECS })
  await start($)
  await mode($, 'acceptEdits')
  expect(await call($, { action: 'start', item: 'p12' })).toBe('refused: runner is subagent; set it with /pipeline config runner=session')
  files.set(CONFIG, config())
  await mode($, 'default')
  const asks = await call($, { action: 'start', item: 'p12' })
  expect(asks).toStartWith("refused: the session's permission mode is default; a headless child cannot ask")
  expect(asks).toContain('acceptEdits, auto, dontAsk or bypassPermissions')
  await mode($, 'plan')
  expect(await call($, { action: 'start', item: 'p12' })).toContain('permission mode is plan')
  await mode($, 'auto')
  expect(await call($, { action: 'start', item: 'p14' })).toBe('refused: p14 is inbox, not ready')
  expect(await call($, { action: 'start', item: 'p99' })).toBe('refused: no item p99')
  expect(await call($, { action: 'start' })).toBe('refused: an id is needed')
  expect(spawned).toEqual([])
  // Only the live file was written, at session start.
  expect(writes.filter(w => w !== LIVE)).toEqual([])
})

test('review 0.2 I5: child records a restart left running are failed at session start, their items blocked, a dead signal raised once; review items are left alone', async ($, on) => {
  const left: Child[] = [
    { id: 'old-12', item: 'p12', worktree: WORKTREE, branch: 'feat/p12', status: 'running', log: 'p12 · task 1/3\n', lastLine: 'p12 · task 1/3' },
    { id: 'old-13', item: 'p13', worktree: `${MAIN}/.claude/worktrees/p13`, branch: 'feat/p13', status: 'starting', log: '' },
    { id: 'old-15', item: 'p15', worktree: `${MAIN}/.claude/worktrees/p15`, branch: 'feat/p15', status: 'finished', log: '', endedAt: NOW - MIN },
  ]
  const backlog = backlogOf([item('p12', 'CSV export', 'building', { note: 'session runner', spec: 'docs/pipeline/specs/p12.md' }), item('p13', 'Second', 'review', { note: 'session runner', spec: 'docs/pipeline/specs/p13.md' }), item('p15', 'Fourth', 'merged', { pr: '#2' })])
  const { files, state, pushes, spawned } = world(on, { [CONFIG]: config(), [BACKLOG]: backlog, ...SPECS, [`${WORKTREE}/.git`]: 'gitdir: x' }, { children: left })
  await start($)
  expect(children(state).map(c => [c.id, c.status, c.lastLine])).toEqual([
    ['old-12', 'failed', 'the parent session restarted'],
    ['old-13', 'failed', 'the parent session restarted'],
    ['old-15', 'finished', undefined],
  ])
  expect(itemOf(files, 'p12')).toMatchObject({ status: 'blocked', note: 'the parent session restarted' })
  expect(itemOf(files, 'p13')).toMatchObject({ status: 'review' })
  expect(itemOf(files, 'p15')).toMatchObject({ status: 'merged' })
  expect((JSON.parse(files.get(`${DIR}/ledgers/p12.json`)!) as { blockers: string[] }).blockers).toEqual(['the parent session restarted'])
  const signals = () => (state.get('signals') ?? []) as Record<string, unknown>[]
  expect(signals().map(s => [s['kind'], s['agent']])).toEqual([
    ['dead', 'child p12'],
    ['dead', 'child p13'],
  ])
  expect(signals()[0]).toMatchObject({ agentId: 'old-12', delivered: false, detail: 'the parent session restarted while the child session ran · p12 blocked · resume with /pipeline run p12' })
  expect(pushes.filter(p => p.includes('dead') && p.includes('child p12'))).toHaveLength(1)
  // Another start (a second reload) raises nothing more; the item is started again as a resume.
  await start($)
  expect(signals()).toHaveLength(2)
  expect(pushes.filter(p => p.includes('dead'))).toHaveLength(2)
  await mode($, 'acceptEdits')
  expect(await call($, { action: 'start', item: 'p12' })).toStartWith('started p12')
  expect(spawned).toHaveLength(1)
  expect(itemOf(files, 'p12')).toMatchObject({ status: 'building', note: 'session runner · was blocked: the parent session restarted' })
})

test('review 0.2 I3: a child session (its worktree, the mark in its environment) may not start children; a building item run in-session is not taken over', async ($, on) => {
  const building = (note?: string) => backlogOf([item('p12', 'CSV export', 'building', { spec: 'docs/pipeline/specs/p12.md', ...(note ? { note } : {}) }), item('p13', 'Second', 'ready')])
  const seed = { [CONFIG]: config(), [BACKLOG]: building('session runner'), ...SPECS, [`${WORKTREE}/.git`]: 'gitdir: x' }
  const { spawned, writes } = world(on, seed, { cwd: WORKTREE, env: { PIPELINE_CHILD: '1', HOME: '/home/u' } })
  await start($)
  await mode($, 'acceptEdits')
  expect(await call($, { action: 'start', item: 'p13' })).toBe('refused: a child session does not start children')
  expect(await call($, { action: 'start', item: 'p12' })).toBe('refused: a child session does not start children')
  expect(spawned).toHaveLength(0)
  expect(writes.filter(w => w !== LIVE)).toEqual([])
})

test('review 0.2 M6: a building item whose note does not say session runner is being run in a session and is not taken over; with the note and no child it resumes', async ($, on) => {
  const building = (note?: string) => backlogOf([item('p12', 'CSV export', 'building', { spec: 'docs/pipeline/specs/p12.md', ...(note ? { note } : {}) })])
  const { spawned, files } = world(on, { [CONFIG]: config(), [BACKLOG]: building('planning in progress'), ...SPECS, [`${WORKTREE}/.git`]: 'gitdir: x' })
  await start($)
  await mode($, 'acceptEdits')
  const answer = await call($, { action: 'start', item: 'p12' })
  expect(answer).toBe('refused: p12 is being run in-session (building, note: planning in progress); finish or stop that run, or block the item, before starting it as a child session')
  expect(spawned).toHaveLength(0)
  files.set(BACKLOG, building())
  expect(await call($, { action: 'start', item: 'p12' })).toContain('note: none')
  // With the runner's note and no child (the parent restarted), the start resumes it.
  files.set(BACKLOG, building('session runner'))
  expect(await call($, { action: 'start', item: 'p12' })).toStartWith('started p12')
  expect(spawned).toHaveLength(1)
  expect(spawned[0]!.request.argv[2]).toContain('Resume item p12')
})

test('Review Focus 4: start makes the worktree, spawns the child there, marks the item building, streams its log; log answers the tail; exit 0 finishes', async ($, on) => {
  const { files, state, runs, spawned, exit, emit } = world(on, { [CONFIG]: config(), [BACKLOG]: READY, ...SPECS })
  await start($)
  await mode($, 'acceptEdits')
  const answer = await call($, { action: 'start', item: 'p12' })
  expect(answer).toMatch(/^started p12 in \.claude\/worktrees\/p12 · session [0-9a-f-]{36} · log \.git\/pipeline\/p12\.log$/)
  // The worktree from the main checkout, off mainBranch, on the item's branch.
  expect(runs).toEqual([['git', 'worktree', 'add', WORKTREE, '-b', 'feat/p12', 'main']])
  // The child: claude -p in the worktree, the parent's mode, the session id the parent chose, marked as a child.
  expect(spawned).toHaveLength(1)
  const { argv, cwd, env } = spawned[0]!.request
  expect(cwd).toBe(WORKTREE)
  expect(env).toEqual({ PIPELINE_CHILD: '1' })
  expect(argv.slice(0, 2)).toEqual(['claude', '-p'])
  expect(argv[2]).toContain('Run item p12 with the pipeline-run skill, runner subagent')
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  const sessionId = argv[argv.indexOf('--session-id') + 1]!
  expect(sessionId).toMatch(UUID)
  expect(argv[argv.indexOf('--name') + 1]).toBe('p12 · CSV export')
  expect(answer).toContain(sessionId)
  // The item and its ledger.
  expect(itemOf(files, 'p12')).toMatchObject({ status: 'building', note: 'session runner', branch: 'feat/p12', ledger: 'docs/pipeline/ledgers/p12.json' })
  expect(JSON.parse(files.get(`${DIR}/ledgers/p12.json`)!)).toMatchObject({ branch: 'feat/p12', worktree: '.claude/worktrees/p12' })
  expect(children(state)).toMatchObject([{ id: sessionId, item: 'p12', status: 'starting', worktree: WORKTREE, branch: 'feat/p12', log: '' }])
  // The parent's own live entry does not claim the item the child owns.
  const live = JSON.parse(files.get(LIVE)!) as { sessions: Record<string, { item?: string }> }
  expect(live.sessions['self']!.item).toBeUndefined()

  // Output streams into the record and the log file as readable lines.
  await emit(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n${assistant('p12 · task 1/4 · implementer dispatched')}\n`)
  expect(children(state)[0]).toMatchObject({ status: 'running', lastLine: 'p12 · task 1/4 · implementer dispatched' })
  expect(files.get(LOG)).toBe('session started\np12 · task 1/4 · implementer dispatched\n')
  await emit('warning: something on stderr\n', 0, 'stderr')
  expect(await call($, { action: 'log', item: 'p12' })).toBe('session started\np12 · task 1/4 · implementer dispatched\nwarning: something on stderr')
  const got = JSON.parse(await call($, { action: 'get' })) as { children: Child[]; siblings: unknown[] }
  expect(got.children).toMatchObject([{ item: 'p12', status: 'running' }])
  expect(got.siblings).toEqual([])
  // A second start of the same item is refused while it runs.
  expect(await call($, { action: 'start', item: 'p12' })).toMatch(/^refused: p12 already runs in session /)

  // The child exits 0: the record is finished, the item stays as the child left it.
  await exit(0)
  expect(children(state)[0]).toMatchObject({ status: 'finished' })
  expect(children(state)[0]!.endedAt).toBeGreaterThanOrEqual(NOW)
  expect(itemOf(files, 'p12')).toMatchObject({ status: 'building' })
  expect(await call($, { action: 'log', item: 'p12' })).toContain('warning: something on stderr')
})

test('review 0.2 I1: get answers each child without its log, so a long run does not fill the answer; log answers the text', async ($, on) => {
  const { emit } = world(on, { [CONFIG]: config(), [BACKLOG]: READY, ...SPECS })
  await start($)
  await mode($, 'acceptEdits')
  await call($, { action: 'start', item: 'p12' })
  const line = assistant('x'.repeat(1000)) + '\n'
  for (let i = 0; i < 150; i++) await emit(line)
  const answer = await call($, { action: 'get' })
  expect(answer.length).toBeLessThan(10_000)
  const parsed = JSON.parse(answer) as { children: Record<string, unknown>[] }
  expect(parsed.children).toHaveLength(1)
  expect(parsed.children[0]).toMatchObject({ item: 'p12', status: 'running', lastLine: 'x'.repeat(1000) })
  expect('log' in parsed.children[0]!).toBe(false)
  expect((await call($, { action: 'log', item: 'p12' })).length).toBe(60 * 1001 - 1)
})

test('stop kills the child and blocks the item with the reason; the exit that follows changes nothing more', async ($, on) => {
  const { files, state, exit, emit, toasts } = world(on, { [CONFIG]: config(), [BACKLOG]: READY, ...SPECS })
  await start($)
  await mode($, 'bypassPermissions')
  await call($, { action: 'start', item: 'p12' })
  await emit(assistant('p12 · planning') + '\n')
  expect(await call($, { action: 'stop', item: 'p13' })).toBe('refused: no child session runs p13')
  const answer = await call($, { action: 'stop', item: 'p12' })
  expect(answer).toMatch(/^stopped p12 · session [0-9a-f-]{36} · p12 blocked: stopped by the user$/)
  expect(children(state)[0]).toMatchObject({ status: 'stopped', endedAt: NOW + 1 })
  expect(itemOf(files, 'p12')).toMatchObject({ status: 'blocked', note: 'stopped by the user' })
  const ledger = JSON.parse(files.get(`${DIR}/ledgers/p12.json`)!) as { blockers: string[] }
  expect(ledger.blockers).toEqual(['stopped by the user'])
  // The engine ends the process with a signal once the loop is left.
  await exit(null, 0, 'SIGTERM')
  expect(children(state)[0]).toMatchObject({ status: 'stopped', endedAt: NOW + 1 })
  expect(itemOf(files, 'p12')).toMatchObject({ status: 'blocked', note: 'stopped by the user' })
  expect(toasts.filter(t => t.includes('failed'))).toEqual([])
  expect(await call($, { action: 'stop', item: 'p12' })).toBe('refused: no child session runs p12')
  // Stopped, the item can be started again: the worktree is reused, the child resumes.
  const { files: f } = { files }
  const again = await call($, { action: 'start', item: 'p12' })
  expect(again).toStartWith('started p12')
  expect(itemOf(f, 'p12')).toMatchObject({ status: 'building', note: 'session runner · was blocked: stopped by the user' })
  expect(children(state)).toHaveLength(1)
  expect(children(state)[0]!.status).toBe('starting')
})

test('review 0.2 I2: stop, then start again before the old process ends: the old loop\'s end leaves the new child\'s process entry, so a second stop still kills it', async ($, on) => {
  const { exit, spawned, emit, state } = world(on, { [CONFIG]: config(), [BACKLOG]: READY, ...SPECS })
  await start($)
  await mode($, 'acceptEdits')
  await call($, { action: 'start', item: 'p12' })
  await emit(assistant('p12 · task 1/3') + '\n')
  expect(await call($, { action: 'stop', item: 'p12' })).toStartWith('stopped p12')
  // The person starts it again at once; the old process has not yet died.
  expect(await call($, { action: 'start', item: 'p12' })).toStartWith('started p12')
  expect(spawned).toHaveLength(2)
  // Now the engine reports the old child dead.
  await exit(null, 0, 'SIGTERM')
  expect(spawned[0]!.returned).toBe(true)
  expect(children(state)).toMatchObject([{ status: 'starting' }])
  // The second stop reaches the new process: its stream is returned, which kills it.
  expect(await call($, { action: 'stop', item: 'p12' })).toStartWith('stopped p12')
  // One more piece from the engine lets the stream reach the return.
  await emit('\n', 1)
  expect(spawned[1]!.returned).toBe(true)
})

test('review 0.2 M3: a child that exits 0 with the item still building: the parent does not claim the item in its own live entry on the next heartbeat', async ($, on) => {
  const { exit, files, clock } = world(on, { [CONFIG]: config(), [BACKLOG]: READY, ...SPECS })
  await start($)
  await mode($, 'acceptEdits')
  await call($, { action: 'start', item: 'p12' })
  await exit(0)
  await clock.advance(31_000)
  expect(itemOf(files, 'p12')).toMatchObject({ status: 'building' })
  const live = JSON.parse(files.get(LIVE)!) as { sessions: Record<string, { item?: string; title: string }> }
  expect(live.sessions['self']!.item).toBeUndefined()
  expect(live.sessions['self']!.title).toBe('main')
})

test('a child that exits non-zero fails and blocks the item with the code and the log tail; the person hears of it', async ($, on) => {
  const { files, state, exit, emit, pushes } = world(on, { [CONFIG]: config(), [BACKLOG]: READY, ...SPECS })
  await start($)
  await mode($, 'dontAsk')
  await call($, { action: 'start', item: 'p12' })
  await emit(`${assistant('p12 · task 1/4')}\nError: out of budget\n`)
  await exit(2)
  expect(children(state)[0]).toMatchObject({ status: 'failed' })
  expect(itemOf(files, 'p12')).toMatchObject({ status: 'blocked', note: 'child exited with code 2: p12 · task 1/4 · Error: out of budget' })
  expect(pushes.some(p => p.includes('child p12') && p.includes('failed'))).toBe(true)
  expect(files.get(LOG)).toBe('p12 · task 1/4\nError: out of budget\n')
  // A merged item is left alone whatever the exit code.
  files.set(BACKLOG, backlogOf([item('p13', 'Second', 'ready')]))
  await call($, { action: 'start', item: 'p13' })
  files.set(BACKLOG, backlogOf([item('p13', 'Second', 'merged', { pr: '#1' })]))
  await exit(1, 1)
  expect(itemOf(files, 'p13')).toMatchObject({ status: 'merged' })
})

test('the parallel limit, run all of the ready items, a worktree reused or re-added on an existing branch, a failed git', async ($, on) => {
  const { files, runs, spawned } = world(on, { [CONFIG]: config({ limits: { parallel: 2 } }), [BACKLOG]: READY, ...SPECS, [`${WORKTREE}/.git`]: 'gitdir: x' }, { worktreeAdd: 'branch-exists' })
  await start($)
  await mode($, 'auto')
  expect(await call($, { action: 'start', item: 'p12' })).toStartWith('started p12')
  // The worktree was there: no git call.
  expect(runs).toEqual([])
  expect(await call($, { action: 'start', item: 'p13' })).toStartWith('started p13')
  // The branch existed from an earlier attempt: added without -b.
  expect(runs).toEqual([
    ['git', 'worktree', 'add', `${MAIN}/.claude/worktrees/p13`, '-b', 'feat/p13', 'main'],
    ['git', 'worktree', 'add', `${MAIN}/.claude/worktrees/p13`, 'feat/p13'],
  ])
  files.set(BACKLOG, backlogOf([...items(files), item('p15', 'Fourth', 'ready')]))
  expect(await call($, { action: 'start', item: 'p15' })).toBe('refused: 2 child sessions running; limits.parallel is 2')
  expect(spawned).toHaveLength(2)
})

test('a git worktree add that fails is refused with its message and nothing is marked', async ($, on) => {
  const { files, spawned, writes } = world(on, { [CONFIG]: config(), [BACKLOG]: READY, ...SPECS }, { worktreeAdd: 'fail' })
  await start($)
  await mode($, 'acceptEdits')
  expect(await call($, { action: 'start', item: 'p12' })).toBe('refused: git worktree add failed: fatal: not a git repository')
  expect(itemOf(files, 'p12')).toMatchObject({ status: 'ready' })
  expect(spawned).toEqual([])
  expect(writes.filter(w => w === BACKLOG)).toEqual([])
})

test("the permission mode also comes from a subagent spawn; the watchdog flags a child whose live entry is stale as silent and one that died with its item building as dead", async ($, on) => {
  const { clock, files, state, exit, pushes, wakeups } = world(on, { [CONFIG]: config(), [BACKLOG]: READY, ...SPECS }, { wakeup: true })
  await start($)
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Implement', subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-x', permissionMode: 'acceptEdits', background: false, fork: false } as never)
  const answer = await call($, { action: 'start', item: 'p12' })
  expect(answer).toStartWith('started p12')
  const sessionId = children(state)[0]!.id
  // The lead's turn ends: a wake-up is scheduled while a child runs, as while an agent runs.
  await ($.turn as unknown as { complete: (e: unknown) => Promise<unknown> }).complete({ reason: 'answer', answer: 'ok' })
  expect(wakeups).toHaveLength(1)
  // The child's own plugin heartbeats into the live file.
  const live = () => JSON.parse(files.get(LIVE)!) as { sessions: Record<string, Record<string, unknown>> }
  const withChild = (seenAt: number) => {
    const l = live()
    l.sessions[sessionId] = { title: 'p12 · CSV export', cwd: WORKTREE, branch: 'feat/p12', item: 'p12', startedAt: new Date(NOW).toISOString(), seenAt: new Date(seenAt).toISOString(), agents: [], signals: [] }
    files.set(LIVE, JSON.stringify(l))
  }
  withChild(NOW + 2 * MIN)
  await clock.advance(2 * MIN + 30_000)
  expect(state.get('signals') ?? []).toEqual([])
  // The child is not a sibling: it is drawn as a child.
  expect(state.get('siblings')).toEqual([])
  // No heartbeat for over three minutes while the process runs: silent, once.
  await clock.advance(4 * MIN)
  const signals = () => (state.get('signals') ?? []) as Record<string, unknown>[]
  expect(signals()).toHaveLength(1)
  expect(signals()[0]).toMatchObject({ kind: 'silent', agent: 'child p12', agentId: sessionId, delivered: false })
  expect(pushes.filter(p => p.includes('silent'))).toHaveLength(1)
  await clock.advance(MIN)
  expect(signals()).toHaveLength(1)
  // The process ends with the item still building: dead.
  await exit(0)
  await clock.advance(30_000)
  expect(signals().map(s => s['kind'])).toEqual(['silent', 'dead'])
  expect(signals()[1]).toMatchObject({ agent: 'child p12', detail: 'the child session exited with p12 still building · resume with /pipeline run p12' })
  await clock.advance(30_000)
  expect(signals()).toHaveLength(2)
})

test('Review Focus 5: another session on the repo shows as a sibling with its item and agents, stale after three minutes, gone once dropped', async ($, on) => {
  const other = { title: 'p13 · Second', cwd: '/p/other', branch: 'feat/p13', item: 'p13', startedAt: new Date(NOW - MIN).toISOString(), seenAt: new Date(NOW).toISOString(), agents: [{ id: 'tu', name: 'Implement', model: 'm', status: 'running', startedAt: NOW, lastStepAt: NOW, calls: 1, tokens: 5, activity: 'editing a.ts', lastCommands: [], failures: 0 }], signals: [] }
  const { clock, files, state } = world(on, { [CONFIG]: config(), [BACKLOG]: READY, ...SPECS, [LIVE]: JSON.stringify({ sessions: { other } }) })
  await start($)
  const siblings = () => (state.get('siblings') ?? []) as Record<string, unknown>[]
  expect(siblings()).toMatchObject([{ sessionId: 'other', title: 'p13 · Second', item: 'p13', branch: 'feat/p13', isStale: false, agents: [{ name: 'Implement', activity: 'editing a.ts' }] }])
  const got = JSON.parse(await call($, { action: 'get' })) as { siblings: Record<string, unknown>[] }
  expect(got.siblings).toMatchObject([{ sessionId: 'other', item: 'p13' }])
  // Its heartbeat keeps it fresh.
  await clock.advance(2 * MIN)
  const l = JSON.parse(files.get(LIVE)!) as { sessions: Record<string, Record<string, unknown>> }
  l.sessions['other'] = { ...other, seenAt: new Date(NOW + 2 * MIN).toISOString() }
  files.set(LIVE, JSON.stringify(l))
  await clock.advance(30_000)
  expect(siblings()[0]).toMatchObject({ isStale: false, seenAt: new Date(NOW + 2 * MIN).toISOString() })
  // Then it goes quiet: stale, and once the watchdog reports its agent dead the entry is dropped and the sibling gone.
  await clock.advance(3 * MIN + 30_000)
  expect(siblings()).toEqual([])
  expect(((state.get('signals') ?? []) as Record<string, unknown>[]).map(s => s['kind'])).toEqual(['dead'])
})

test('a sibling with no agents that goes quiet stays listed as stale until its entry is a day old', async ($, on) => {
  const other = { title: 'p13 · Second', cwd: '/p/other', item: 'p13', startedAt: new Date(NOW - MIN).toISOString(), seenAt: new Date(NOW).toISOString(), agents: [], signals: [] }
  const { clock, state } = world(on, { [CONFIG]: config(), [BACKLOG]: READY, ...SPECS, [LIVE]: JSON.stringify({ sessions: { other } }) })
  await start($)
  await clock.advance(4 * MIN)
  expect((state.get('siblings') as Record<string, unknown>[])[0]).toMatchObject({ sessionId: 'other', isStale: true })
})

test('the commands: next and run under runner session hand the model a start prompt; stop <id> and log <id> answer from the mod', async ($, on) => {
  const { clock, emit, state, submitted } = world(on, { [CONFIG]: config(), [BACKLOG]: READY, ...SPECS })
  await start($)
  await mode($, 'acceptEdits')
  const run = async (args: string) => {
    const a = (await $.command.run({ command: 'pipeline', args, origin: { kind: 'composer' } } as never)) as { text?: string }
    await clock.advance(100)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    return a.text ?? ''
  }
  const last = () => submitted[submitted.length - 1] ?? ''
  await run('next')
  expect(last()).toContain('runner session')
  expect(last()).toContain(`${TOOL} {"action":"start","item":"<id>"}`)
  expect(last()).toContain('the first ready item')
  await run('run p13')
  expect(last()).toContain('item p13')
  await run('run all')
  expect(last()).toContain('limits.parallel')
  expect(last()).toContain('each time a child finishes')
  expect(await run('log p12')).toBe('no log for p12')
  expect(await run('stop p12')).toBe('pipeline: no child session runs p12')
  await call($, { action: 'start', item: 'p12' })
  await emit(assistant('p12 · task 1/3') + '\n')
  expect(await run('log p12')).toBe('p12 · task 1/3')
  expect(await run('stop p12')).toMatch(/^stopped p12 · session /)
  expect(children(state)[0]!.status).toBe('stopped')
  // Without an id, stop is the in-session stop prompt as before.
  const before = submitted.length
  await run('stop')
  expect(submitted).toHaveLength(before + 1)
  expect(last()).toMatch(/Finish the task that is running/)
  expect(await run('log')).toBe('pipeline: log needs an id, as /pipeline log p12')
})

test('runner subagent: next and run keep the in-session prompt', async ($, on) => {
  const { clock, submitted } = world(on, { [CONFIG]: config({ runner: 'subagent' }), [BACKLOG]: READY, ...SPECS })
  await start($)
  await $.command.run({ command: 'pipeline', args: 'next', origin: { kind: 'composer' } } as never)
  await clock.advance(100)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  expect(submitted[0]).toContain('run the first ready item')
  expect(submitted[0]).not.toContain('"start"')
})
