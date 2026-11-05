import { expect, test } from 'claude-code/testing'

import type { AgentRun, Signal } from '../types'
import { activityOf, deadAgents, isProtected, matchesGlob, normalizeCommand, onCall, onComplete, onResult, onSpawn, onStep, signals } from './watch'

const LIMITS = { fixRounds: 3, silentMinutes: 10, taskMinutes: 45, itemTokens: 4_000_000 }
const T0 = Date.parse('2026-11-05T10:00:00Z')
const MIN = 60_000

const spawn = (at = T0): AgentRun[] => onSpawn([], { id: 'tu1', agentId: 'a1', name: 'Implement Task 2', model: 'claude-x', at })

test('activityOf gives a short phrase, never the raw command', () => {
  const long = 'cd /p/main && FOO=1 npm run check:fast -- --reporter=dot ' + '&& echo done '.repeat(50)
  expect(long.length).toBeGreaterThan(600)
  const a = activityOf({ tool: 'Bash', command: long })
  expect(a).toBe('running npm run check:fast')
  expect(a.length).toBeLessThan(60)
  expect(activityOf({ tool: 'Bash', command: 'ls -la' })).toBe('running ls')
  expect(activityOf({ tool: 'Bash', command: 'git status --porcelain' })).toBe('running git status')
  expect(activityOf({ tool: 'Edit', file_path: '/p/main/app/export.server.ts', old_string: 'a', new_string: 'b' })).toBe('editing export.server.ts')
  expect(activityOf({ tool: 'Write', file_path: 'C:\\p\\main\\README.md' })).toBe('editing README.md')
  expect(activityOf({ tool: 'NotebookEdit', notebook_path: '/p/nb.ipynb' })).toBe('editing nb.ipynb')
  expect(activityOf({ tool: 'Read', file_path: '/p/main/docs/pipeline/plans/p12.md' })).toBe('reading p12.md')
  expect(activityOf({ tool: 'Grep', pattern: 'TODO' })).toBe('searching "TODO"')
  expect(activityOf({ tool: 'Glob', pattern: '**/*.ts' })).toBe('searching "**/*.ts"')
  expect(activityOf({ tool: 'mcp__claude-in-chrome__navigate', url: 'x' })).toBe('waiting on a browser page')
  expect(activityOf({ tool: 'WebFetch', url: 'x' })).toBe('waiting on a browser page')
  expect(activityOf({ tool: 'Agent', prompt: 'p' })).toBe('dispatching a subagent')
  expect(activityOf({ tool: 'TaskStop' })).toBe('using TaskStop')
})

test('normalizeCommand trims, collapses spaces and drops env assignments', () => {
  expect(normalizeCommand('  FOO=1  BAR=x  npm   test ')).toBe('npm test')
  expect(normalizeCommand('cd x && CI=true npm test')).toBe('cd x && npm test')
  expect(normalizeCommand('npm test')).toBe(normalizeCommand('npm\ttest\n'))
})

test('onSpawn, onStep, onCall, onResult and onComplete keep the agent table', () => {
  let list = spawn()
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ id: 'tu1', agentId: 'a1', name: 'Implement Task 2', model: 'claude-x', status: 'running', startedAt: T0, lastStepAt: T0, calls: 0, tokens: 0, activity: 'starting', lastCommands: [], failures: 0 })
  list = onStep(list, 'a1', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 }, T0 + MIN)
  expect(list[0]).toMatchObject({ lastStepAt: T0 + MIN, tokens: 1125 })
  list = onStep(list, 'other', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, T0 + 2 * MIN)
  expect(list[0]!.tokens).toBe(1125)
  list = onCall(list, 'a1', { tool: 'Read', file_path: '/p/a.ts' }, T0 + 2 * MIN)
  expect(list[0]).toMatchObject({ calls: 1, activity: 'reading a.ts' })
  list = onComplete(list, 'a1', 'answer', T0 + 3 * MIN)
  expect(list[0]).toMatchObject({ status: 'done', endedAt: T0 + 3 * MIN })
  const failed = onComplete(spawn(), 'a1', 'error', T0 + MIN)
  expect(failed[0]).toMatchObject({ status: 'failed', endedAt: T0 + MIN })
  expect(onResult(list, 'a1', { tool: 'Bash', command: 'x' }, true)[0]!.failures).toBe(0)
})

test('looping: the same failing command three times, raised once; a success breaks the streak', () => {
  let list = spawn()
  const run = (cmd: string, isError: boolean) => {
    list = onCall(list, 'a1', { tool: 'Bash', command: cmd }, T0)
    list = onResult(list, 'a1', { tool: 'Bash', command: cmd }, isError)
  }
  run('npm test', true)
  run('CI=1 npm  test', true)
  expect(signals(list, LIMITS, T0 + MIN, [])).toEqual([])
  run('npm test', true)
  expect(list[0]).toMatchObject({ lastCommands: ['npm test', 'npm test', 'npm test'], failures: 3 })
  const first = signals(list, LIMITS, T0 + MIN, [])
  expect(first).toHaveLength(1)
  expect(first[0]).toMatchObject({ kind: 'looping', agent: 'Implement Task 2', agentId: 'a1', at: T0 + MIN, delivered: false })
  expect(first[0]!.detail).toContain('npm test')
  expect(signals(list, LIMITS, T0 + 2 * MIN, first)).toEqual([])
  run('npm test', false)
  expect(list[0]).toMatchObject({ lastCommands: [], failures: 0 })
})

test('looping: more failed commands than fixRounds', () => {
  let list = spawn()
  for (const cmd of ['a', 'b', 'c', 'd']) {
    list = onCall(list, 'a1', { tool: 'Bash', command: cmd }, T0)
    list = onResult(list, 'a1', { tool: 'Bash', command: cmd }, true)
  }
  const s = signals(list, LIMITS, T0 + MIN, [])
  expect(s.map(x => x.kind)).toEqual(['looping'])
  expect(s[0]!.detail).toContain('4 failed commands')
})

test('silent after silentMinutes without a step, raised once; a done agent raises nothing', () => {
  const list = onCall(spawn(), 'a1', { tool: 'Bash', command: 'npm test' }, T0)
  expect(signals(list, LIMITS, T0 + 9 * MIN, [])).toEqual([])
  const s = signals(list, LIMITS, T0 + 10 * MIN, [])
  expect(s).toHaveLength(1)
  expect(s[0]).toMatchObject({ kind: 'silent', agent: 'Implement Task 2', agentId: 'a1', at: T0 + 10 * MIN, delivered: false })
  expect(s[0]!.detail).toContain('10 min')
  expect(s[0]!.detail).toContain('running npm test')
  expect(signals(list, LIMITS, T0 + 20 * MIN, s)).toEqual([])
  expect(signals(list, LIMITS, T0 + 20 * MIN, s.map(x => ({ ...x, delivered: true })))).toEqual([])
  expect(signals(onComplete(list, 'a1', 'answer', T0 + MIN), LIMITS, T0 + 20 * MIN, [])).toEqual([])
})

test('a step resets the silence', () => {
  let list = spawn()
  list = onStep(list, 'a1', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, T0 + 8 * MIN)
  expect(signals(list, LIMITS, T0 + 15 * MIN, [])).toEqual([])
  expect(signals(list, LIMITS, T0 + 18 * MIN, []).map(s => s.kind)).toEqual(['silent'])
})

test('budget after taskMinutes, once per agent; two agents each get their own', () => {
  let list = spawn()
  list = onSpawn(list, { id: 'tu2', agentId: 'a2', name: 'Review', model: 'claude-y', at: T0 + 5 * MIN })
  list = onStep(list, 'a1', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, T0 + 44 * MIN)
  list = onStep(list, 'a2', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, T0 + 44 * MIN)
  const at45 = signals(list, LIMITS, T0 + 45 * MIN, [])
  expect(at45.map(s => [s.kind, s.agentId])).toEqual([['budget', 'a1']])
  expect(at45[0]!.detail).toContain('45 min')
  const at50 = signals(list, LIMITS, T0 + 50 * MIN, at45)
  expect(at50.map(s => [s.kind, s.agentId])).toEqual([['budget', 'a2']])
})

test('deadAgents: agents running under this session id or a stale entry; a fresh other session is alive', () => {
  const run: AgentRun = { id: 'tu1', agentId: 'a1', name: 'Implement Task 2', model: 'm', status: 'running', startedAt: T0, lastStepAt: T0, calls: 1, tokens: 0, activity: 'editing a.ts', lastCommands: [], failures: 0 }
  const done: AgentRun = { ...run, id: 'tu0', agentId: 'a0', name: 'Old', status: 'done' }
  const entry = (seenAt: number, agents: AgentRun[], item?: string) => ({ title: 't', cwd: '/p', ...(item ? { item } : {}), startedAt: new Date(T0).toISOString(), seenAt: new Date(seenAt).toISOString(), agents, signals: [] as Signal[] })
  const now = T0 + 60 * MIN
  const live = {
    sessions: {
      self: entry(T0 + 30 * MIN, [run, done], 'p12'),
      stale: entry(T0 + 10 * MIN, [{ ...run, agentId: 'a7', name: 'Stale one' }]),
      fresh: entry(now - 20_000, [{ ...run, agentId: 'a9', name: 'Alive' }]),
    },
  }
  const dead = deadAgents(live, 'self', now)
  expect(dead.signals.map(s => [s.kind, s.agentId, s.agent])).toEqual([
    ['dead', 'a1', 'Implement Task 2'],
    ['dead', 'a7', 'Stale one'],
  ])
  expect(dead.signals[0]).toMatchObject({ at: now, delivered: false })
  expect(dead.signals[0]!.detail).toContain('p12')
  expect(dead.signals[0]!.detail).toContain('editing a.ts')
  expect(dead.sessions).toEqual(['self', 'stale'])
  expect(deadAgents({ sessions: {} }, 'self', now)).toEqual({ signals: [], sessions: [] })
})

test('matchesGlob: *, ** and ?', () => {
  expect(matchesGlob('.github/workflows/ci.yml', '.github/workflows/**')).toBe(true)
  expect(matchesGlob('.github/workflows/a/b/ci.yml', '.github/workflows/**')).toBe(true)
  expect(matchesGlob('.github/workflows', '.github/workflows/**')).toBe(false)
  expect(matchesGlob('.github/other/ci.yml', '.github/workflows/**')).toBe(false)
  expect(matchesGlob('src/a/b/c.test.ts', '**/*.test.ts')).toBe(true)
  expect(matchesGlob('c.test.ts', '**/*.test.ts')).toBe(true)
  expect(matchesGlob('src/a.ts', 'src/*.ts')).toBe(true)
  expect(matchesGlob('src/a/b.ts', 'src/*.ts')).toBe(false)
  expect(matchesGlob('src/a.ts', 'src/?.ts')).toBe(true)
  expect(matchesGlob('src/ab.ts', 'src/?.ts')).toBe(false)
  expect(matchesGlob('src/a.ts', 'src/a.ts')).toBe(true)
  expect(matchesGlob('src/a+ts', 'src/a.ts')).toBe(false)
  expect(matchesGlob('a\\b\\c.yml', 'a/b/*.yml')).toBe(true)
})

test('isProtected matches the path, or the path relative to a root', () => {
  const globs = ['.github/workflows/**', 'package-lock.json']
  expect(isProtected('/p/main/.github/workflows/ci.yml', globs, ['/p/main'])).toBe(true)
  expect(isProtected('/p/wt/task-7/.github/workflows/ci.yml', globs, ['/p/main', '/p/wt/task-7'])).toBe(true)
  expect(isProtected('/p/wt/task-7/package-lock.json', globs, ['/p/wt/task-7/'])).toBe(true)
  expect(isProtected('/p/main/src/ci.yml', globs, ['/p/main'])).toBe(false)
  expect(isProtected('/elsewhere/.github/workflows/ci.yml', globs, ['/p/main'])).toBe(false)
  expect(isProtected('.github/workflows/ci.yml', globs, [])).toBe(true)
  expect(isProtected('/p/main/.github/workflows/ci.yml', ['/p/main/.github/**'], [])).toBe(true)
  expect(isProtected('/p/main/x', [], ['/p/main'])).toBe(false)
})
