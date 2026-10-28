import { expect, mock, test } from 'claude-code/testing'

import { parseReport, runIdOf, segment, slug } from './bridge'

const PROGRESS = 'mcp__superpowers-flow__progress'
const SKILL = '# superpowers-flow\n\n## 1. Tier instead of model\n\n## 2. Progress bar\n'
const ROOT = '/repo/.git/superpowers-flow'
const spawn = { tool_use_id: 't1', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as const

// The host beneath the plugin: git answers the common dir and the branch, the files live in `files`.
const host = (on: Parameters<Parameters<typeof test>[1]>[1], files: Map<string, { text: string; mtimeMs: number }>) => {
  const ran: string[][] = []
  on('process.run', (_$, e) => {
    const { argv } = e as { argv: string[] }
    ran.push([...argv])
    if (argv.includes('--git-common-dir')) return { value: { exitCode: 0, stdout: '/repo/.git\n', stderr: '' } } as never
    if (argv.includes('--abbrev-ref')) return { value: { exitCode: 0, stdout: 'feature/login\n', stderr: '' } } as never
    if (argv[0] === 'rm') {
      for (const k of [...files.keys()]) if (k.startsWith(argv[2] + '/')) files.delete(k)
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'unknown' } } as never
  })
  on('fs.write', (_$, e) => {
    const { path, text } = e as { path: string; text: string }
    files.set(path, { text, mtimeMs: (files.get(path)?.mtimeMs ?? 0) + 1 })
    return { value: undefined } as never
  })
  on('fs.read', (_$, e) => {
    const f = files.get((e as { path: string }).path)
    return f ? ({ value: f.text } as never) : ({ deny: 'ENOENT' } as never)
  })
  on('fs.list', (_$, e) => {
    const dir = (e as { path: string }).path + '/'
    const names = new Map<string, { kind: 'file' | 'dir'; mtimeMs: number }>()
    for (const [k, f] of files) {
      if (!k.startsWith(dir)) continue
      const rest = k.slice(dir.length)
      const [head = '', ...more] = rest.split('/')
      names.set(head, more.length ? { kind: 'dir', mtimeMs: 0 } : { kind: 'file', mtimeMs: f.mtimeMs })
    }
    return { value: [...names].map(([name, v]) => ({ name, kind: v.kind, size: 0, mtimeMs: v.mtimeMs, isLink: false })) } as never
  })
  on('fs.stat', (_$, e) => {
    const path = (e as { path: string }).path
    return path.startsWith('/wt/') ? ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } as never) : ({ deny: 'ENOENT' } as never)
  })
  return ran
}

// `/flow-config runner=session`, as the user would set it.
const sessionRunner = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
  await $.command.run({ command: 'flow-config', args: 'runner=session' } as never)
}
const configHooks = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const row = { key: 'superpowers-flow.runner', label: 'runner', kind: 'choice', value: 'profile', options: ['profile', 'subagent', 'worktree', 'session'], provider: { plugin: 'superpowers-flow', tier: 'user' }, isLocked: false }
  on('config.list', () => ({ value: [row] }) as never)
  on('config.set', (_$, e) => ({ value: (e as { value: unknown }).value }) as never)
}

test('bridge: run ids and slice names are safe path segments', () => {
  expect(slug('Ship the Login Form!')).toBe('ship-the-login-form')
  expect(runIdOf(Date.UTC(2026, 9, 28), 'feature/login', 'Login form')).toBe('2026-10-28-feature-login-login-form')
  expect(segment('../../etc')).toBe('etc')
  expect(segment(42)).toBe('')
})

test('bridge: a malformed or hostile report is cut down field by field', () => {
  expect(parseReport('{not json', 'r', 's')).toBeNull()
  const r = parseReport(JSON.stringify({ title: 'x'.repeat(500), done: 9, total: 3, costUsd: -5, tasks: ['a', 1, 'b'] }), 'r', 's')
  expect(r?.title.length).toBe(120)
  expect(r?.done).toBe(3)
  expect(r?.costUsd).toBe(0)
  expect(r?.tasks).toEqual(['a', 'b'])
})

// A brief that names a worktree starts its worker there; a path that is not a folder is ignored.
test('bridge: a Worktree line in the brief sets where the worker runs', async ($, on) => {
  mock.clock(on)
  host(on, new Map())
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const cwds: (string | undefined)[] = []
  on('agent.spawn', (_$, e) => {
    cwds.push((e as { cwd?: string }).cwd)
    return { model: 'claude-opus-5-5', agentId: `a${cwds.length}` }
  })
  const base = { ...spawn, description: 'Task 1', subagentType: 'superpowers-flow:sp-light' }
  await $.agent.spawn({ ...base, prompt: 'Do task 1.\nWorktree: /wt/app-wt-a\nMore.' } as never)
  await $.agent.spawn({ ...base, tool_use_id: 't2', prompt: 'Do task 2.\nWorktree: /nowhere\n' } as never)
  await $.agent.spawn({ ...base, tool_use_id: 't3', prompt: 'No worktree here.' } as never)
  expect(cwds).toEqual(['/wt/app-wt-a', undefined, undefined])
})

// The slice session: its progress calls land in its own file under the run's folder.
test('bridge: a slice session writes its report on every progress call', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const files = new Map<string, { text: string; mtimeMs: number }>()
  host(on, files)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 5000, window: 1_000_000 }, rateLimits: [], cost: { usd: 0.42 } } }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)

  const tasks = [{ title: 'Add priority', tier: 'light' }, { title: 'Sort by priority', tier: 'light', after: [1] }]
  await $.tool.call({ tool: PROGRESS, run: 'run-1', slice: 'a', title: 'Slice A', phase: 'delegate', tasks } as never)
  const path = `${ROOT}/run-1/a.json`
  const first = JSON.parse(files.get(path)?.text ?? '{}')
  expect(first).toMatchObject({ run: 'run-1', slice: 'a', title: 'Slice A', done: 0, total: 2, isFinished: false, costUsd: 0.42, model: 'claude-opus-5-5' })
  expect(first.tasks).toEqual(['Add priority', 'Sort by priority'])

  await clock.advance(5000)
  await $.tool.call({ tool: PROGRESS, done: 2, finished: true } as never)
  expect(JSON.parse(files.get(path)?.text ?? '{}')).toMatchObject({ done: 2, isFinished: true, updatedAt: 6000 })
})

// The session that started the slices: it reads them into the panel and /flow-status,
// and their tasks are no longer listed as planned.
test('bridge: the parent shows each slice from its file', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 28, 10) })
  const files = new Map<string, { text: string; mtimeMs: number }>()
  host(on, files)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  configHooks(on)
  mock.env(on, { LANG: 'en_US.UTF-8' })
  // The bridge is read on a tick the session's start sets up.
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await sessionRunner($)

  const tasks = [
    { title: 'Add priority', tier: 'light' },
    { title: 'Search command', tier: 'light' },
    { title: 'Docs', tier: 'light', after: [1, 2] },
  ]
  const out = await $.tool.call({ tool: PROGRESS, title: 'Todo app', phase: 'delegate', tasks } as never)
  const run = '2026-10-28-feature-login-todo-app'
  expect(String((out as { result?: string }).result)).toContain('ok: Tasks 0/3 · run 2026-10-28-feature-login-todo-app')

  const at = clock.now()
  const report = (slice: string, title: string, done: number, total: number, isFinished: boolean, taskTitles: string[]) =>
    JSON.stringify({ title, done, total, phase: 'delegate', isFinished, note: isFinished ? '' : 'Task 1 · tests', model: 'claude-opus-5-5', costUsd: 0.5, contextTokens: 9000, contextMax: 1_000_000, workers: 2, running: 1, startedAt: at, updatedAt: at, tasks: taskTitles })
  files.set(`${ROOT}/${run}/a.json`, { text: report('a', 'Priority', 1, 1, true, ['Add priority']), mtimeMs: 1 })
  files.set(`${ROOT}/${run}/b.json`, { text: report('b', 'Search', 0, 1, false, ['Search command']), mtimeMs: 1 })
  await clock.advance(2100)

  const text = String(((await $.command.run({ command: 'flow-status', args: '' } as never)) as { text?: string }).text)
  expect(text).toContain('● b · Search  ·  session · Opus 5.5 · 0/1 Task 1 · tests')
  expect(text).toContain('✓ a · Priority  ·  session · Opus 5.5 · 1/1')
  expect(text).toContain('Planned · 1')
  expect(text).toContain('◷ 3. Docs')
  expect(text).not.toContain('◷ 1. Add priority')

  // A slice that stops writing, unfinished, is drawn as failed after five minutes.
  await clock.advance(6 * 60 * 1000)
  const later = String(((await $.command.run({ command: 'flow-status', args: '' } as never)) as { text?: string }).text)
  expect(later).toContain('✗ b · Search')
})

// With runner `session` the parent's first report names the run and its folder.
test('bridge: with runner session the progress result names the run and folder', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 28, 10) })
  host(on, new Map())
  on('ui.open', () => ({ value: { isPlaced: true } }))
  configHooks(on)
  await sessionRunner($)
  const out = await $.tool.call({ tool: PROGRESS, title: 'Todo app', phase: 'delegate', total: 2 } as never)
  expect(String((out as { result?: string }).result)).toContain(`run 2026-10-28-feature-login-todo-app · bridge folder ${ROOT}/2026-10-28-feature-login-todo-app`)
})

// A session started with the slice environment reports as that slice and follows the
// run's settings, never the session runner itself.
test('bridge: a slice session joins its run from the environment and takes its settings', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const files = new Map<string, { text: string; mtimeMs: number }>()
  host(on, files)
  mock.env(on, { LANG: 'en_US.UTF-8', SUPERPOWERS_FLOW_RUN: 'run-9', SUPERPOWERS_FLOW_SLICE: 'b' })
  files.set(`${ROOT}/run-9/_run.json`, { text: JSON.stringify({ options: { taskReview: 'final', runner: 'session', parallel: 'independent', reviewerTier: 'light', evil: 'x y' } }), mtimeMs: 1 })
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  on('skill.prompt', (_$, e) => ({ text: (e as { text: string }).text }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ source: 'startup', cwd: '/wt/b', surface: 'terminal', isInteractive: false } as never)

  const skill = String(((await $.skill.prompt({ skill: 'superpowers-flow:superpowers-flow', text: SKILL } as never)) as { text: string }).text)
  expect(skill).toContain('Task reviews are off')
  expect(skill).toContain('- Task reviewers and re-reviewers: `sp-light`.')
  expect(skill).not.toContain('own Claude Code sessions')
  expect(skill).not.toContain('run at once')

  // No run or slice in the call: the environment already said which.
  await $.tool.call({ tool: PROGRESS, title: 'Slice B', phase: 'delegate', total: 1 } as never)
  expect(JSON.parse(files.get(`${ROOT}/run-9/b.json`)?.text ?? '{}')).toMatchObject({ run: 'run-9', slice: 'b', title: 'Slice B', total: 1 })
})

// The parent writes the run's settings beside the slices, and reads it as no slice.
test('bridge: the parent writes the run settings, which are not a slice', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 28, 10) })
  const files = new Map<string, { text: string; mtimeMs: number }>()
  host(on, files)
  configHooks(on)
  mock.env(on, { LANG: 'en_US.UTF-8' })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await sessionRunner($)
  await $.tool.call({ tool: PROGRESS, title: 'Calc', phase: 'delegate', total: 2 } as never)
  const run = `${ROOT}/2026-10-28-feature-login-calc`
  expect(JSON.parse(files.get(`${run}/_run.json`)?.text ?? '{}').options).toMatchObject({ runner: 'session', taskReview: 'each' })
  await clock.advance(2100)
  const text = String(((await $.command.run({ command: 'flow-status', args: '' } as never)) as { text?: string }).text)
  expect(text).toBe('```\nCalc · Tasks 0/2 · 0%\n```')
})

// Session start removes runs whose slices all finished and that sat for three days, nothing else.
test('bridge: old finished runs are removed at session start', async ($, on) => {
  const day = 24 * 3600 * 1000
  const clock = mock.clock(on, { now: 10 * day })
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const ran = host(on, files)
  mock.env(on, { LANG: 'en_US.UTF-8' })
  const done = JSON.stringify({ isFinished: true })
  files.set(`${ROOT}/old-done/a.json`, { text: done, mtimeMs: 1 * day })
  files.set(`${ROOT}/old-open/a.json`, { text: JSON.stringify({ isFinished: false }), mtimeMs: 1 * day })
  files.set(`${ROOT}/new-done/a.json`, { text: done, mtimeMs: 9 * day })
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  expect(ran.filter(a => a[0] === 'rm')).toEqual([['rm', '-rf', `${ROOT}/old-done`]])
  expect([...files.keys()].sort()).toEqual([`${ROOT}/new-done/a.json`, `${ROOT}/old-open/a.json`])
})
