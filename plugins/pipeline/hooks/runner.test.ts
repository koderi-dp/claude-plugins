import { expect, test } from 'claude-code/testing'

import type { Backlog, ChildSession, Item, LiveEntry } from '../types'
import { ALLOWED_MODES, LOG_CAP, LOG_KEEP, appendOutput, branchOf, childArgv, childPrompt, childSignals, exitNote, parseChildLine, runningOf, startable, tail, withExit, withStopped, worktreeOf } from './runner'
import { STALE_MS } from './watch'

const T0 = Date.parse('2026-11-09T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const child = (extra: Partial<ChildSession> = {}): ChildSession => ({ id: 'sid-1', item: 'p12', worktree: '/p/main/.claude/worktrees/p12', branch: 'feat/p12', status: 'running', startedAt: T0, log: '', ...extra })
const item = (id: string, status: Item['status'], extra: Partial<Item> = {}): Item => ({ id, title: `Item ${id}`, status, ...extra })
const backlogOf = (items: Item[]): Backlog => ({ version: 1, items })
const entry = (seenAt: number, item?: string): LiveEntry => ({ title: 't', cwd: '/p', startedAt: iso(T0), seenAt: iso(seenAt), agents: [], signals: [], ...(item ? { item } : {}) })

test('childArgv: a headless print run in the given permission mode, prompts denied, plugins as installed, the session id when given', () => {
  const argv = childArgv({ prompt: 'Run p12', permissionMode: 'acceptEdits', sessionId: '2b1f0a9e-1111-4222-8333-444455556666' })
  expect(argv.slice(0, 3)).toEqual(['claude', '-p', 'Run p12'])
  expect(argv).toContain('--permission-mode')
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  expect(argv[argv.indexOf('--permission-prompts') + 1]).toBe('none')
  expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json')
  expect(argv).toContain('--verbose')
  expect(argv[argv.indexOf('--session-id') + 1]).toBe('2b1f0a9e-1111-4222-8333-444455556666')
  expect(argv).not.toContain('--name')
  const named = childArgv({ prompt: 'Run p12', permissionMode: 'auto', name: 'p12 · CSV export' })
  expect(named[named.indexOf('--name') + 1]).toBe('p12 · CSV export')
  expect(named).not.toContain('--session-id')
  // No plugin flag: the child loads the installed plugins as the parent did.
  expect(argv.some(a => a.startsWith('--plugin'))).toBe(false)
  expect(childArgv({ prompt: 'x', permissionMode: 'auto' })).not.toContain('--session-id')
  expect(ALLOWED_MODES).toEqual(['acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'])
})

test('childPrompt names the item, the run skill, the subagent runner, the worktree as this directory and the building status already set', () => {
  const p = childPrompt('p12')
  expect(p).toContain('p12')
  expect(p).toContain('pipeline-run')
  expect(p).toContain('runner subagent')
  expect(p).toContain('this directory')
  expect(p).toMatch(/already .*building/)
  expect(p).toContain('mcp__pipeline__pipeline {"action":"get"}')
  expect(p).not.toMatch(/EnterWorktree(?!.*(?:not|never|skip))/i)
  expect(childPrompt('p12', { isResume: true })).toContain('Resume')
})

test('parseChildLine turns stream-json events into readable lines and passes other text through', () => {
  expect(parseChildLine('')).toBe(null)
  expect(parseChildLine('   ')).toBe(null)
  expect(parseChildLine('plain stderr text')).toBe('plain stderr text')
  expect(parseChildLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'm', session_id: 's' }))).toBe('session started')
  expect(parseChildLine(JSON.stringify({ type: 'system', subtype: 'other' }))).toBe(null)
  const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'p12 · task 1/4 · implementer dispatched\nsecond line' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', name: 'Edit', input: { file_path: '/p/src/a.ts' } }, { type: 'tool_use', name: 'Agent', input: { description: 'Implement task 1' } }] } }
  expect(parseChildLine(JSON.stringify(assistant))).toBe('p12 · task 1/4 · implementer dispatched\n→ Bash npm test\n→ Edit /p/src/a.ts\n→ Agent Implement task 1')
  expect(parseChildLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }))).toBe(null)
  expect(parseChildLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'p12 merged · PR #31', num_turns: 40, total_cost_usd: 1.2345 }))).toBe('result: p12 merged · PR #31 · 40 turns · $1.23')
  expect(parseChildLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', num_turns: 3 }))).toBe('result: error_max_turns · 3 turns')
  expect(parseChildLine(JSON.stringify({ type: 'stream_event' }))).toBe(null)
  expect(parseChildLine('{"type": 5')).toBe('{"type": 5')
})

test('appendOutput keeps the readable lines, a partial line waits for its end, the last line is the latest, the log is capped', () => {
  const a = appendOutput(child(), 'first line\n{"type":"assistant","message":{"content":[{"type":"text","text":"p12 · task 1/3"}]}}\npart', '')
  expect(a.child.log).toBe('first line\np12 · task 1/3\n')
  expect(a.child.lastLine).toBe('p12 · task 1/3')
  expect(a.partial).toBe('part')
  const b = appendOutput(a.child, 'ial line\n', a.partial)
  expect(b.child.log).toBe('first line\np12 · task 1/3\npartial line\n')
  expect(b.child.lastLine).toBe('partial line')
  expect(b.partial).toBe('')
  const c = appendOutput(b.child, '\n\n', b.partial)
  expect(c.child.log).toBe(b.child.log)
  const long = appendOutput(child(), 'x'.repeat(LOG_CAP + 10) + '\n', '')
  expect(long.child.log.length).toBeLessThanOrEqual(LOG_KEEP + 60)
  expect(long.child.log).toStartWith('… earlier output dropped …\n')
})

test('withExit: code 0 finished, another code failed, a signal stopped; withStopped marks a running child stopped once', () => {
  expect(withExit(child(), { code: 0, signal: null }, T0 + 5)).toMatchObject({ status: 'finished', endedAt: T0 + 5 })
  expect(withExit(child(), { code: 2, signal: null }, T0 + 5)).toMatchObject({ status: 'failed', endedAt: T0 + 5 })
  expect(withExit(child(), { code: null, signal: 'SIGTERM' }, T0 + 5)).toMatchObject({ status: 'stopped', endedAt: T0 + 5 })
  const stopped = withStopped(child(), T0 + 1)
  expect(stopped).toMatchObject({ status: 'stopped', endedAt: T0 + 1 })
  // A child that already ended keeps its end.
  expect(withExit(stopped, { code: 0, signal: null }, T0 + 9)).toEqual(stopped)
  expect(withStopped(withExit(child(), { code: 0, signal: null }, T0 + 5), T0 + 9)).toMatchObject({ status: 'finished', endedAt: T0 + 5 })
  expect(runningOf([child(), child({ item: 'p2', status: 'starting' }), child({ item: 'p3', status: 'finished' }), child({ item: 'p4', status: 'failed' })]).map(c => c.item)).toEqual(['p12', 'p2'])
})

test('tail answers the last lines; exitNote names the code and the tail', () => {
  const log = Array.from({ length: 70 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  expect(tail(log).split('\n')).toHaveLength(60)
  expect(tail(log)).toStartWith('line 11\n')
  expect(tail(log)).toEndWith('line 70')
  expect(tail('a\nb\n', 5)).toBe('a\nb')
  expect(tail('', 5)).toBe('')
  expect(exitNote(child({ log }), { code: 2, signal: null })).toBe('child exited with code 2: line 68 · line 69 · line 70')
  expect(exitNote(child({ log: '' }), { code: null, signal: 'SIGKILL' })).toBe('child ended by SIGKILL')
})

test('startable: ready items whose needs are merged, none already in flight, up to the free slots', () => {
  const b = backlogOf([item('p1', 'merged'), item('p2', 'ready'), item('p3', 'ready', { needs: ['p1'] }), item('p4', 'ready', { needs: ['p9'] }), item('p5', 'inbox'), item('p6', 'ready'), item('p7', 'building')])
  expect(startable(b, [], 1).map(i => i.id)).toEqual(['p2'])
  expect(startable(b, [], 3).map(i => i.id)).toEqual(['p2', 'p3', 'p6'])
  expect(startable(b, [child({ item: 'p2' })], 3).map(i => i.id)).toEqual(['p3', 'p6'])
  expect(startable(b, [child({ item: 'p2' }), child({ item: 'p7' })], 2)).toEqual([])
  expect(startable(b, [child({ item: 'p2', status: 'finished' })], 1).map(i => i.id)).toEqual(['p2'])
  expect(startable(b, [], 0)).toEqual([])
})

test('childSignals: a running child with a stale or missing live entry is silent; one that ended with its item still building is dead', () => {
  const now = T0 + 10 * 60_000
  const items = [item('p12', 'building'), item('p2', 'building'), item('p3', 'merged'), item('p4', 'blocked')]
  const live = { sessions: { 'sid-1': entry(now - STALE_MS - 1, 'p12'), 'sid-fresh': entry(now, 'p2') } }
  const children = [child(), child({ id: 'sid-fresh', item: 'p2' }), child({ id: 'sid-3', item: 'p3', status: 'finished', endedAt: now - 1 }), child({ id: 'sid-4', item: 'p4', status: 'failed', endedAt: now - 1 }), child({ id: 'sid-5', item: 'p5', status: 'starting', startedAt: now - 1000 })]
  const signals = childSignals({ children, live, items: [...items, item('p5', 'building')], now, staleMs: STALE_MS })
  expect(signals).toEqual([{ kind: 'silent', agent: 'child p12', agentId: 'sid-1', detail: `no heartbeat from the child session for ${Math.floor((STALE_MS + 1) / 60_000)} min while its process runs`, at: now, delivered: false }])
  // A child whose process ended while the item is still building is dead; the merged and blocked ones are not.
  const ended = childSignals({ children: [child({ status: 'finished', endedAt: now - 5 })], live: { sessions: {} }, items, now, staleMs: STALE_MS })
  expect(ended).toEqual([{ kind: 'dead', agent: 'child p12', agentId: 'sid-1', detail: 'the child session exited with p12 still building · resume with /pipeline run p12', at: now, delivered: false }])
  // A child just started has no entry yet and is not silent before the stale limit.
  expect(childSignals({ children: [child({ status: 'starting', startedAt: now - 1000 })], live: { sessions: {} }, items, now, staleMs: STALE_MS })).toEqual([])
  expect(childSignals({ children: [child({ startedAt: now - STALE_MS - 1 })], live: { sessions: {} }, items, now, staleMs: STALE_MS })[0]).toMatchObject({ kind: 'silent' })
})

test('worktreeOf and branchOf', () => {
  expect(worktreeOf('/p/main', 'p12')).toBe('/p/main/.claude/worktrees/p12')
  expect(worktreeOf('C:\\p\\main\\', 'p12')).toBe('C:/p/main/.claude/worktrees/p12')
  expect(branchOf('feat/<id>', 'p12')).toBe('feat/p12')
  expect(branchOf('pipeline/<id>-x', 'p12')).toBe('pipeline/p12-x')
  expect(branchOf('plain', 'p12')).toBe('plain/p12')
})
