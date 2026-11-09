import { expect, test } from 'claude-code/testing'
import type { Backlog, Item, Ledger } from '../types'

import { DEFAULTS } from './config'
import { displayTitle, idleLine, prLabel, statusText, taskCounter } from './status'
import type { StatusInput } from './status'

const NOW = Date.parse('2026-11-05T12:00:00Z')
const item = (id: string, status: Item['status'], rest: Partial<Item> = {}): Item => ({ id, title: `Item ${id}`, status, ...rest })
const backlog = (...items: Item[]): Backlog => ({ version: 1, items })

const base = (over: Partial<StatusInput> = {}): StatusInput => ({ config: DEFAULTS, backlog: backlog(), readiness: {}, ledger: null, agents: [], signals: [], now: NOW, ...over })

const LEDGER: Ledger = {
  item: 'p12',
  branch: 'feat/p12',
  resume: { task: 3, state: 'fix round 2 dispatched', lastVerified: 'b70de44', at: '2026-11-05T11:02:00Z' },
  tasks: [
    { n: 1, title: 'Export job schema', status: 'accepted', dispatches: [{ role: 'implementer', model: 'sonnet', effort: 'medium', tokens: 1, minutes: 2, result: 'done' }] },
    { n: 2, title: 'Export runner', status: 'accepted', dispatches: [], review: { kind: 'independent', verdict: 'approved' } },
    { n: 3, title: 'The route', status: 'fix', dispatches: [] },
    { n: 4, title: 'Docs', status: 'pending', dispatches: [] },
    { n: 5, title: 'Final', status: 'pending', dispatches: [] },
    { n: 6, title: 'Merge', status: 'pending', dispatches: [] },
  ],
  rulings: [{ n: 1, task: 2, text: 'Keep the snapshot id', why: 'immutable', costIfWrong: 'exports change' }],
  blockers: [],
  final: null,
  tokens: 592000,
}

test('no config says so in one line', () => {
  expect(statusText(base({ config: null, backlog: null }))).toBe('pipeline: no config (run /pipeline init)')
})

test('a file error is the head line', () => {
  const text = statusText(base({ backlog: null, fileError: 'docs/pipeline/backlog.json: line 3: Unexpected token' }))
  expect(text.split('\n')[0]).toBe('pipeline: docs/pipeline/backlog.json: line 3: Unexpected token')
})

test('the active item carries the task counter and the resume state', () => {
  const text = statusText(base({ backlog: backlog(item('p12', 'building', { title: 'CSV export', size: 'M' })), ledger: LEDGER }))
  expect(text).toContain('pipeline: 1 item · 0 ready')
  expect(text).toContain('Active\n  p12 · CSV export · M · building · task 3/6 · fix round 2 dispatched')
})

test('agents and signals follow the active item', () => {
  const text = statusText(
    base({
      backlog: backlog(item('p12', 'building')),
      agents: [
        { id: 'a1', name: 'implementer', model: 'sonnet', status: 'running', startedAt: NOW - 14 * 60000, lastStepAt: NOW, calls: 3, tokens: 1, activity: 'editing export.ts', lastCommands: [], failures: 0 },
        { id: 'a0', name: 'reviewer', model: 'opus', status: 'done', startedAt: NOW - 60 * 60000, lastStepAt: NOW, calls: 3, tokens: 1, activity: '', lastCommands: [], failures: 0 },
      ],
      signals: [
        { kind: 'silent', agent: 'implementer', detail: 'no step for 10 min', at: NOW, delivered: false },
        { kind: 'budget', agent: 'reviewer', detail: 'over', at: NOW, delivered: true },
      ],
    }),
  )
  expect(text).toContain('Agents\n  implementer · sonnet · 14 min · editing export.ts\n')
  expect(text).not.toContain('reviewer · opus')
  expect(text).toContain('Signals\n  silent: implementer · no step for 10 min')
  expect(text).not.toContain('budget:')
})

test('the queues: five ready, blocked with reasons, inbox with the readiness reason, merged this week', () => {
  const ready = [1, 2, 3, 4, 5, 6].map(n => item(`p${n}`, 'ready', { size: 'S' }))
  const text = statusText(
    base({
      backlog: backlog(
        ...ready,
        item('p7', 'blocked', { note: 'CI red on main' }),
        item('p8', 'inbox'),
        item('p9', 'inbox', { needs: ['p99'] }),
        item('p10', 'merged', { pr: 'https://x/pull/10', updatedAt: '2026-11-03T00:00:00Z' }),
        item('p11', 'merged', { pr: 'https://x/pull/11', updatedAt: '2026-10-01T00:00:00Z' }),
        item('p13', 'parked'),
      ),
      readiness: { p8: { ready: false, reason: 'open question in the spec' }, p9: { ready: false, reason: 'p99 does not exist' } },
    }),
  )
  expect(text).toContain('pipeline: 12 items · 6 ready')
  expect(text).toContain('Ready\n  p1 · Item p1 · S\n  p2 · Item p2 · S\n  p3 · Item p3 · S\n  p4 · Item p4 · S\n  p5 · Item p5 · S\n  … and 1 more ready\n')
  expect(text).not.toContain('p6 · Item p6')
  expect(text).toContain('Blocked\n  p7 · Item p7 · CI red on main\n')
  expect(text).toContain('Inbox\n  p8 · Item p8 · open question in the spec\n  p9 · Item p9 · p99 does not exist\n')
  expect(text).toContain('Parked: p13\n')
  expect(text).toContain('Merged this week\n  p10 · Item p10 · https://x/pull/10')
  expect(text).not.toContain('p11 · Item p11')
  expect(text).not.toContain('Agents')
  expect(text).not.toContain('Signals')
})

test('taskCounter reads the resume block and the task list', () => {
  expect(taskCounter(null)).toBe(undefined)
  expect(taskCounter({ ...LEDGER, resume: undefined, tasks: [] })).toBe(undefined)
  expect(taskCounter(LEDGER)).toBe('task 3/6')
})

test('displayTitle drops a migrated slug and keeps every other title', () => {
  expect(displayTitle('grid-track-sizes — Grid row and column sizes')).toBe('Grid row and column sizes')
  expect(displayTitle('export-csv - CSV export')).toBe('CSV export')
  expect(displayTitle('Grid row and column sizes')).toBe('Grid row and column sizes')
  expect(displayTitle('Login — the second step')).toBe('Login — the second step')
  expect(displayTitle('grid-track-sizes—Grid')).toBe('grid-track-sizes—Grid')
  expect(displayTitle('a-b — ')).toBe('a-b — ')
})

test('prLabel reads the number from a URL, a #NN or a bare number', () => {
  expect(prLabel('https://github.com/x/y/pull/35')).toEqual({ label: '#35', href: 'https://github.com/x/y/pull/35' })
  expect(prLabel('#35')).toEqual({ label: '#35' })
  expect(prLabel('35')).toEqual({ label: '#35' })
  expect(prLabel('https://x/compare/a..b')).toEqual({ label: 'https://x/compare/a..b' })
  expect(prLabel(null)).toBe(undefined)
  expect(prLabel('')).toBe(undefined)
})

test('the text status shows migrated titles without their slug', () => {
  const text = statusText(base({ backlog: backlog(item('p1', 'ready', { title: 'grid-track-sizes — Grid row and column sizes' }), item('p2', 'inbox', { title: 'Plain title' })) }))
  expect(text).toContain('Ready\n  p1 · Grid row and column sizes\n')
  expect(text).toContain('Inbox\n  p2 · Plain title')
  expect(text).not.toContain('grid-track-sizes')
})

test('idleLine counts the inbox and names the first ready item, else the first inbox item', () => {
  const inbox = [item('p3', 'inbox', { title: 'grid-track-sizes — Grid row and column sizes' }), item('p4', 'inbox')]
  expect(idleLine([item('p1', 'merged'), ...inbox, item('p2', 'ready', { title: 'CSV export' })])).toBe('idle · 2 inbox · next: p2 CSV export')
  expect(idleLine([item('p1', 'merged'), ...inbox])).toBe('idle · 2 inbox · next: p3 Grid row and column sizes')
  expect(idleLine([item('p1', 'merged')])).toBe('idle · 0 inbox')
})
