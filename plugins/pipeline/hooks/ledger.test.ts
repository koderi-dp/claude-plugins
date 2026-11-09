import { expect, test } from 'claude-code/testing'
import type { Item, Ledger } from '../types'

import { emptyLedger, ledgerText, mergeLedger } from './ledger'

const NOW = '2026-11-05T10:00:00.000Z'
const item = (id: string, status: Item['status'], rest: Partial<Item> = {}): Item => ({ id, title: `Item ${id}`, status, ...rest })
const dispatch = (tokens: number, result: string, rest: Record<string, unknown> = {}) => ({ role: 'implementer' as const, model: 'sonnet', effort: 'medium', tokens, minutes: 1, result, ...rest })

const LEDGER: Ledger = {
  item: 'p12',
  branch: 'feat/p12',
  worktree: '.claude/worktrees/p12',
  pr: '#31',
  resume: { task: 3, state: 'fix round 2 dispatched', lastVerified: 'b70de44', at: '2026-11-05T11:02:00Z' },
  tasks: [
    { n: 1, title: 'Export job schema', status: 'accepted', commits: 'a3f91c2..c1d2e3f', dispatches: [dispatch(1, 'done')] },
    { n: 2, title: 'Export runner', status: 'accepted', dispatches: [dispatch(2, 'fix round 1'), dispatch(3, 'done'), dispatch(4, 'FIX REQUIRED', { role: 'reviewer' })], review: { kind: 'independent', verdict: 'approved after fix round 1' } },
    { n: 3, title: 'The route', status: 'fix', dispatches: [] },
    { n: 4, title: 'Docs', status: 'pending', dispatches: [] },
    { n: 5, title: 'Final', status: 'pending', dispatches: [] },
    { n: 6, title: 'Merge', status: 'pending', dispatches: [] },
  ],
  rulings: [{ n: 1, task: 2, text: 'Keep the snapshot id', why: 'immutable', costIfWrong: 'exports change' }],
  blockers: [],
  final: null,
  tokens: 10,
}

test('emptyLedger carries the item id and empty lists', () => {
  expect(emptyLedger('p12')).toEqual({ item: 'p12', pr: null, tasks: [], rulings: [], blockers: [], final: null, tokens: 0 })
})

test('a task entry merged twice keeps both dispatches and the later status', () => {
  let l = mergeLedger(emptyLedger('p12'), { tasks: [{ n: 1, title: 'One', status: 'pending', dispatches: [] }, { n: 2, title: 'Two', status: 'pending', dispatches: [] }] }, NOW)
  l = mergeLedger(l, { tasks: [{ n: 2, status: 'running' }] }, NOW)
  l = mergeLedger(l, { tasks: [{ n: 2, dispatches: [dispatch(100, 'fix round 1')] }] }, NOW)
  l = mergeLedger(l, { tasks: [{ n: 2, status: 'accepted', commits: 'a..b', dispatches: [dispatch(50, 'done')], review: { kind: 'lead-diff', verdict: 'accepted' } }] }, NOW)
  expect(l.tasks.map(t => t.n)).toEqual([1, 2])
  expect(l.tasks[1]).toEqual({ n: 2, title: 'Two', status: 'accepted', commits: 'a..b', dispatches: [dispatch(100, 'fix round 1'), dispatch(50, 'done')], review: { kind: 'lead-diff', verdict: 'accepted' } })
  expect(l.tasks[0]).toEqual({ n: 1, title: 'One', status: 'pending', dispatches: [] })
})

test('a task with a new n is appended and the list stays sorted by n', () => {
  const l = mergeLedger(mergeLedger(emptyLedger('p1'), { tasks: [{ n: 3, title: 'Three' }] }, NOW), { tasks: [{ n: 1, title: 'One' }] }, NOW)
  expect(l.tasks.map(t => [t.n, t.title, t.status, t.dispatches])).toEqual([
    [1, 'One', 'pending', []],
    [3, 'Three', 'pending', []],
  ])
})

test('rulings number themselves and keep the task they belong to', () => {
  let l = mergeLedger(emptyLedger('p1'), { rulings: [{ task: 2, text: 'A', why: 'a', costIfWrong: 'x' }] }, NOW)
  l = mergeLedger(l, { rulings: [{ n: 9, text: 'B', why: 'b', costIfWrong: 'y' }, { text: 'C', why: 'c', costIfWrong: 'z' }] }, NOW)
  expect(l.rulings).toEqual([
    { n: 1, task: 2, text: 'A', why: 'a', costIfWrong: 'x' },
    { n: 2, text: 'B', why: 'b', costIfWrong: 'y' },
    { n: 3, text: 'C', why: 'c', costIfWrong: 'z' },
  ])
})

test('tokens are the sum of every dispatch plus the final review', () => {
  let l = mergeLedger(emptyLedger('p1'), { tasks: [{ n: 1, dispatches: [dispatch(100, 'done')] }, { n: 2, dispatches: [dispatch(20, 'a'), dispatch(30, 'b')] }] }, NOW)
  expect(l.tokens).toBe(150)
  l = mergeLedger(l, { final: { verdict: 'approved', gate: 'green', tokens: 1000 } }, NOW)
  expect(l.tokens).toBe(1150)
  expect(l.final).toEqual({ verdict: 'approved', gate: 'green', tokens: 1000 })
  l = mergeLedger(l, { tokens: 5 } as never, NOW)
  expect(l.tokens).toBe(1150)
})

test('resume is replaced whole and stamped with the time when it carries none', () => {
  let l = mergeLedger(emptyLedger('p1'), { resume: { task: 1, state: 'planned', lastVerified: 'abc' } }, NOW)
  expect(l.resume).toEqual({ task: 1, state: 'planned', lastVerified: 'abc', at: NOW })
  l = mergeLedger(l, { resume: { task: 2, state: 'implementer dispatched', at: '2026-11-06T00:00:00Z' } }, NOW)
  expect(l.resume).toEqual({ task: 2, state: 'implementer dispatched', at: '2026-11-06T00:00:00Z' })
})

test('blockers append without duplicates; pr, branch, worktree, base and plan are set; unknown fields survive', () => {
  const current = { ...emptyLedger('p1'), colour: 'red' } as Ledger
  let l = mergeLedger(current, { blockers: ['CI red'], branch: 'feat/p1', worktree: '.claude/worktrees/p1', base: 'a1', plan: 'docs/pipeline/plans/p1.md' }, NOW)
  l = mergeLedger(l, { blockers: ['CI red', 'needs a credential'], pr: '#31', extra: 1 } as never, NOW)
  expect(l).toMatchObject({ item: 'p1', colour: 'red', branch: 'feat/p1', worktree: '.claude/worktrees/p1', base: 'a1', plan: 'docs/pipeline/plans/p1.md', pr: '#31', blockers: ['CI red', 'needs a credential'], extra: 1 })
  expect(current.blockers).toEqual([])
})

test('mergeLedger never writes the item id from set', () => {
  const l = mergeLedger(emptyLedger('p1'), { item: 'p2' } as never, NOW)
  expect(l.item).toBe('p1')
})

test('ledgerText shows the resume line first, then where it lives, the tasks, rulings and totals', () => {
  const text = ledgerText(LEDGER, item('p12', 'building', { title: 'CSV export' }))
  const lines = text.split('\n')
  expect(lines[0]).toBe('p12 · CSV export · building · resume: task 3/6 · fix round 2 dispatched · verified b70de44 · at 2026-11-05T11:02:00Z')
  expect(lines[1]).toBe('  branch feat/p12 · worktree .claude/worktrees/p12 · PR #31')
  expect(text).toContain('Tasks\n  1 · Export job schema · accepted · a3f91c2..c1d2e3f · 1 dispatch (implementer)\n  2 · Export runner · accepted · 3 dispatches (implementer ×2, reviewer) · approved after fix round 1\n  3 · The route · fix\n')
  expect(text).toContain('Rulings\n  R1 (task 2): Keep the snapshot id — immutable — exports change')
  expect(text).toContain('Tokens: 10')
  expect(text).not.toContain('Blockers')
  expect(text).not.toContain('Final:')
})

test('ledgerText without an item, with blockers and a final verdict', () => {
  const l: Ledger = { ...emptyLedger('p3'), blockers: ['CI red after one fix wave'], final: { verdict: 'approved', gate: 'green', tokens: 7, findings: ['minor: wording'] }, tokens: 7 }
  const text = ledgerText(l, null)
  expect(text.split('\n')[0]).toBe('p3 · no resume')
  expect(text).toContain('Blockers\n  CI red after one fix wave')
  expect(text).toContain('Final: approved · gate green · 7 tokens\n  minor: wording')
  expect(text).toContain('Tokens: 7')
  expect(text).not.toContain('Tasks')
})

test('close ends the dispatch a brief call opened, and falls back to the last one', () => {
  const open = { role: 'implementer' as const, model: 'sonnet', effort: 'medium', tokens: 0, minutes: 0, result: '', brief: 'b.md', report: 'r.md' }
  const one = mergeLedger(emptyLedger('p1'), { tasks: [{ n: 1, title: 'A', status: 'running', dispatches: [dispatch(5, 'done'), open] }] }, NOW)
  const closed = mergeLedger(one, { tasks: [{ n: 1, close: { tokens: 240000, minutes: 31, result: 'done' } }] }, NOW)
  expect(closed.tasks[0]!.dispatches[1]).toEqual({ ...open, tokens: 240000, minutes: 31, result: 'done' })
  expect(closed.tasks[0]!.dispatches[0]!.tokens).toBe(5)
  expect(closed.tokens).toBe(240005)
  expect('close' in closed.tasks[0]!).toBe(false)
  const again = mergeLedger(closed, { tasks: [{ n: 1, close: { result: 'fix round 1' } }] }, NOW)
  expect(again.tasks[0]!.dispatches[1]!.result).toBe('fix round 1')
  // No dispatch at all: nothing to close, nothing invented.
  expect(mergeLedger(emptyLedger('p1'), { tasks: [{ n: 1, close: { result: 'x' } }] }, NOW).tasks[0]!.dispatches).toEqual([])
})
