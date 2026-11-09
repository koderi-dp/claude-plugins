import { expect, test } from 'claude-code/testing'
import type { Backlog, Item, Ledger } from '../types'

import { DEFAULTS } from './config'
import { displayTitle, idleLine, prLabel, sessionName, statusText, taskCounter } from './status'
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

test('sessionName: the id and the title without its slug, cut to 60 characters', () => {
  expect(sessionName({ id: 'p1', title: 'grid-track-sizes — Grid row and column sizes' })).toBe('p1 · Grid row and column sizes')
  expect(sessionName({ id: 'p12', title: 'CSV export' })).toBe('p12 · CSV export')
  const long = sessionName({ id: 'p2', title: 'x'.repeat(80) })
  expect(long).toBe(`p2 · ${'x'.repeat(59)}…`)
  expect(long.length - 'p2 · '.length).toBe(60)
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

// ---------- the dashboard's derivations ----------

import { currentTask, groupCounts, heroSentence, mergedItems, mergedThisWeek, queueItems, roleOf, stepsOf, tagOf } from './status'

const MIXED: Item[] = [
  item('p1', 'inbox', { title: 'Grid row and column sizes' }),
  item('p2', 'inbox', { title: 'Brand logos' }),
  item('p3', 'ready', { title: 'Search' }),
  item('p4', 'building', { title: 'Export' }),
  item('p5', 'blocked', { title: 'Import' }),
  item('p6', 'parked', { title: 'Later' }),
  item('p7', 'merged', { title: 'Login', updatedAt: '2026-11-04T00:00:00Z' }),
  item('p8', 'merged', { title: 'Old', updatedAt: '2026-10-01T00:00:00Z' }),
  item('p9', 'merged', { title: 'Newest', updatedAt: '2026-11-05T00:00:00Z' }),
]

test('groupCounts: ready holds the items in flight, all everything but the merged', () => {
  expect(groupCounts(MIXED)).toEqual({ inbox: 2, ready: 2, blocked: 1, parked: 1, all: 6 })
})

test('queueItems: the filter picks the group, in flight first under ready, and the search narrows by id or title', () => {
  expect(queueItems(MIXED, 'inbox', '').map(i => i.id)).toEqual(['p1', 'p2'])
  expect(queueItems(MIXED, 'ready', '').map(i => i.id)).toEqual(['p4', 'p3'])
  expect(queueItems(MIXED, 'all', '').map(i => i.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
  expect(queueItems(MIXED, 'inbox', 'logo').map(i => i.id)).toEqual(['p2'])
  expect(queueItems(MIXED, 'all', 'P5').map(i => i.id)).toEqual(['p5'])
  expect(queueItems(MIXED, 'inbox', 'nothing')).toEqual([])
  expect(queueItems([item('q1', 'inbox', { title: 'grid-track — Grid sizes' })], 'inbox', 'grid sizes')).toHaveLength(1)
})

test('mergedItems: newest first, the week when asked; equal dates in array order reversed, so a migrated list reads newest first', () => {
  expect(mergedItems(MIXED, NOW).map(i => i.id)).toEqual(['p9', 'p7', 'p8'])
  expect(mergedItems(MIXED, NOW, 7 * 24 * 60 * 60_000).map(i => i.id)).toEqual(['p9', 'p7'])
  const migrated = ['m1', 'm2', 'm3'].map(id => item(id, 'merged', { updatedAt: '2026-11-05T00:00:00Z', note: 'imported from docs/backlog.md' }))
  expect(mergedItems(migrated, NOW).map(i => i.id)).toEqual(['m3', 'm2', 'm1'])
  expect(mergedItems([...migrated, item('m4', 'merged')], NOW).map(i => i.id)).toEqual(['m3', 'm2', 'm1', 'm4'])
})

test('mergedThisWeek: merged by the pipeline within seven days; an imported item never counts, whatever its date', () => {
  const week = 7 * 24 * 60 * 60_000
  expect(mergedThisWeek(MIXED, NOW).map(i => i.id)).toEqual(['p9', 'p7'])
  const imported = [item('m1', 'merged', { updatedAt: new Date(NOW - 1000).toISOString(), note: 'imported from docs/backlog.md' }), item('m2', 'merged', { updatedAt: new Date(NOW - 1000).toISOString(), note: 'imported from docs/backlog.md; no PR link' })]
  expect(mergedThisWeek(imported, NOW)).toEqual([])
  expect(mergedThisWeek([...imported, item('p1', 'merged', { updatedAt: new Date(NOW - week).toISOString(), note: 'PR merged' })], NOW).map(i => i.id)).toEqual(['p1'])
  expect(mergedThisWeek([item('p2', 'merged', { updatedAt: new Date(NOW - week - 1).toISOString() })], NOW)).toEqual([])
  expect(mergedThisWeek([item('p3', 'merged')], NOW)).toEqual([])
  expect(mergedThisWeek([item('p4', 'ready', { updatedAt: new Date(NOW).toISOString() })], NOW)).toEqual([])
})

test('heroSentence says how many wait, how many are ready and what moves work', () => {
  expect(heroSentence(MIXED)).toBe('There are 2 items in your inbox and 1 is ready to build. Run /pipeline next to start the first.')
  expect(heroSentence([item('p1', 'inbox'), item('p2', 'inbox')])).toBe('There are 2 items in your inbox, but none are ready to build. Add specifications to move work into the queue.')
  expect(heroSentence([item('p1', 'inbox')])).toBe('There is 1 item in your inbox, but none are ready to build. Add specifications to move work into the queue.')
  expect(heroSentence([item('p3', 'ready'), item('p4', 'ready')])).toBe('2 items are ready to build. Run /pipeline next to start the first.')
  expect(heroSentence([item('p7', 'merged')])).toBe('The inbox is empty and nothing is ready to build. Add work with /pipeline add.')
})

test('stepsOf marks Plan, Build, Review and Merge from the status and the ledger', () => {
  const states = (steps: ReturnType<typeof stepsOf>) => steps.map(s => s.state)
  expect(states(stepsOf(item('p1', 'planning'), null))).toEqual(['current', 'pending', 'pending', 'pending'])
  expect(states(stepsOf(item('p1', 'building'), null))).toEqual(['done', 'current', 'pending', 'pending'])
  expect(states(stepsOf(item('p1', 'building'), { ...LEDGER, resume: { task: 6, state: 'final review dispatched', at: '' } }))).toEqual(['done', 'done', 'current', 'pending'])
  expect(states(stepsOf(item('p1', 'building'), { ...LEDGER, final: { verdict: 'approved' } }))).toEqual(['done', 'done', 'current', 'pending'])
  expect(states(stepsOf(item('p1', 'review'), null))).toEqual(['done', 'done', 'current', 'pending'])
  expect(states(stepsOf(item('p1', 'merged'), null))).toEqual(['done', 'done', 'done', 'done'])
  expect(states(stepsOf(item('p1', 'ready'), null))).toEqual(['pending', 'pending', 'pending', 'pending'])
  expect(stepsOf(null, null).map(s => s.name)).toEqual(['Plan', 'Build', 'Review', 'Merge'])
})

test('currentTask is the running or fix task, else the resume block\'s', () => {
  expect(currentTask(LEDGER)?.n).toBe(3)
  expect(currentTask({ ...LEDGER, tasks: LEDGER.tasks.map(t => (t.n === 3 ? { ...t, status: 'pending' as const } : t)) })?.n).toBe(3)
  expect(currentTask({ ...LEDGER, resume: undefined, tasks: LEDGER.tasks.filter(t => t.n !== 3) })).toBe(undefined)
  expect(currentTask(null)).toBe(undefined)
})

test('review 0.2 C1: a ledger without a tasks array (valid JSON from another tool) gives no current task, the name\'s role and an empty band', () => {
  const bare = { item: 'p12', tokens: 0 } as unknown as Ledger
  expect(currentTask(bare)).toBe(undefined)
  expect(roleOf({ name: 'Implement task 3' }, bare)).toEqual({ role: 'implementer' })
  const noDispatches = { ...LEDGER, tasks: LEDGER.tasks.map(t => ({ n: t.n, title: t.title, status: t.status })) } as unknown as Ledger
  expect(currentTask(noDispatches)?.n).toBe(3)
  expect(roleOf({ name: 'Review task 3' }, noDispatches)).toEqual({ role: 'reviewer' })
  expect(bandOf(item('p12', 'building'), bare, undefined, NOW)).toMatchObject({ state: 'BUILDING', count: '', segments: [], tasks: [] })
  expect(stepsOf(item('p12', 'building'), bare).map(s => s.state)).toEqual(['done', 'current', 'pending', 'pending'])
})

test('roleOf: the current task\'s last dispatch, else the name\'s role word, else the name', () => {
  const dispatched = { ...LEDGER, tasks: LEDGER.tasks.map(t => (t.n === 3 ? { ...t, dispatches: [{ role: 'reviewer' as const, model: 'x', effort: 'high', tokens: 1, minutes: 1, result: '' }] } : t)) }
  expect(roleOf({ name: 'Implement task 3' }, dispatched)).toEqual({ role: 'reviewer', effort: 'high' })
  expect(roleOf({ name: 'Implement task 3' }, LEDGER)).toEqual({ role: 'implementer' })
  expect(roleOf({ name: 'Review task 2' }, null)).toEqual({ role: 'reviewer' })
  expect(roleOf({ name: 'Final review of p12' }, null)).toEqual({ role: 'final' })
  expect(roleOf({ name: 'Explore the repo' }, null)).toEqual({ role: 'Explore the repo' })
  const plain = { ...dispatched, tasks: dispatched.tasks.map(t => (t.n === 3 ? { ...t, dispatches: [{ ...t.dispatches[0]!, effort: 'default' }] } : t)) }
  expect(roleOf({ name: 'x' }, plain)).toEqual({ role: 'reviewer' })
})

test('tagOf: the word and the colour kind of a row', () => {
  expect(tagOf(item('p1', 'inbox'), 'no spec')).toEqual({ text: 'No spec', kind: 'blocked' })
  expect(tagOf(item('p1', 'inbox'))).toEqual({ text: 'Inbox', kind: 'muted' })
  expect(tagOf(item('p1', 'ready'))).toEqual({ text: 'Ready', kind: 'ready' })
  expect(tagOf(item('p1', 'building'))).toEqual({ text: 'Building', kind: 'running' })
  expect(tagOf(item('p1', 'blocked'))).toEqual({ text: 'Blocked', kind: 'blocked' })
  expect(tagOf(item('p1', 'parked'))).toEqual({ text: 'Parked', kind: 'muted' })
  expect(tagOf(item('p1', 'merged'))).toEqual({ text: 'Merged', kind: 'done' })
})

import { attemptText, attemptsOf, currentLine, leadLine, reviewNote } from './status'

const FIX_TASK: Ledger['tasks'][number] = {
  n: 2,
  title: 'The writer',
  status: 'fix',
  dispatches: [
    { role: 'implementer', model: 'claude-sonnet-5-5', effort: 'medium', tokens: 10, minutes: 3.3333, result: 'done' },
    { role: 'reviewer', model: 'claude-opus-5-5', effort: 'high', tokens: 20, minutes: 0.97, result: 'FIX REQUIRED: the test for the empty case is missing' },
    { role: 'implementer', model: 'claude-sonnet-5-5', effort: 'medium', tokens: 5, minutes: 0.62, result: 'done' },
  ],
}

test('attemptsOf: the task\'s dispatches as Build, Review with its verdict and Fix n of max, each with its model and minutes as a clock', () => {
  const trail = attemptsOf(FIX_TASK, 2)
  expect(trail.map(attemptText)).toEqual(['Build · Sonnet 5.5 · 3:20 ✓', 'Review · Opus 5.5 · 0:58 · FIX REQUIRED', 'Fix 1 of 2 · Sonnet 5.5 · 0:37 ✓'])
  const more = attemptsOf({ dispatches: [...FIX_TASK.dispatches, { role: 'reviewer', model: 'claude-opus-5-5', effort: 'high', tokens: 1, minutes: 1, result: 'APPROVED with notes' }, { role: 'final', model: 'claude-opus-5-5', effort: 'xhigh', tokens: 1, minutes: 2, result: 'approved' }, { role: 'escalate', model: 'claude-opus-5-5', effort: 'high', tokens: 1, minutes: 0.5, result: '' }] }, 3)
  expect(more.map(attemptText).slice(3)).toEqual(['Review · Opus 5.5 · 1:00 · APPROVED', 'Final review · Opus 5.5 · 2:00 · APPROVED', 'Escalation · Opus 5.5 · 0:30 ✓'])
  expect(attemptsOf(undefined, 3)).toEqual([])
  expect(attemptsOf({ dispatches: [] }, 3)).toEqual([])
  // review 0.2 C1: a task record without dispatches.
  expect(attemptsOf({ n: 1, title: 'a', status: 'running' } as unknown as Ledger['tasks'][number], 3)).toEqual([])
})

test('currentLine: the fix round with the review\'s verdict, else the running agent\'s role, model and clock, else the last dispatch\'s model', () => {
  const agent = (name: string, model: string) => ({ id: 'a', name, model, status: 'running' as const, startedAt: NOW - 108_000, lastStepAt: NOW, calls: 0, tokens: 0, activity: '', lastCommands: [], failures: 0 })
  expect(currentLine(FIX_TASK, undefined, LEDGER, 2, NOW)).toBe('Fix round 1 of 2 · after review: FIX REQUIRED')
  expect(currentLine(FIX_TASK, agent('Implement task 2', 'claude-sonnet-5-5'), LEDGER, 3, NOW)).toBe('Fix round 1 of 3 · after review: FIX REQUIRED')
  expect(currentLine({ ...FIX_TASK, dispatches: FIX_TASK.dispatches.slice(0, 1) }, undefined, LEDGER, 3, NOW)).toBe('Fix round 1 of 3')
  const building = { ...FIX_TASK, status: 'running' as const, dispatches: FIX_TASK.dispatches.slice(0, 1) }
  expect(currentLine(building, agent('Implement task 2', 'claude-sonnet-5-5'), null, 3, NOW)).toBe('Implementer · Sonnet 5.5 · 1:48')
  expect(currentLine(building, agent('Review task 2', 'claude-opus-5-5'), null, 3, NOW - 50_000)).toBe('Review · Opus 5.5 · 0:58')
  expect(currentLine(building, agent('Final review of p12', 'claude-opus-5-5'), null, 3, NOW)).toBe('Final review · Opus 5.5 · 1:48')
  expect(currentLine(building, undefined, null, 3, NOW)).toBe('Sonnet 5.5')
  expect(currentLine({ ...building, dispatches: [] }, undefined, null, 3, NOW)).toBe('')
})

test('leadLine: what the lead does and how long since, from the resume block', () => {
  expect(leadLine({ ...LEDGER, resume: { task: 2, state: 'fix round 1 dispatched', at: new Date(NOW - 130_000).toISOString() } }, NOW)).toBe('Lead · fix round 1 dispatched · 2:10')
  expect(leadLine({ ...LEDGER, resume: { task: 2, state: 'reading the review of task 2', at: 'not a date' } }, NOW)).toBe('Lead · reading the review of task 2')
  expect(leadLine(null, NOW)).toBe('Lead · between dispatches')
})

import { specWhat } from './status'

test('specWhat reads the first paragraph under What, else the first paragraph, cut to 160 characters', () => {
  expect(specWhat('# p14 Second image per card\n\nStatus: draft\n\n## What\n\nImplementing a second image slot for article cards.\nMore.\n\n## Why\n')).toBe('Implementing a second image slot for article cards.')
  expect(specWhat('# Title\n\n- a list\n\nThe first paragraph.\n')).toBe('The first paragraph.')
  expect(specWhat(`## What\n\n${'x'.repeat(200)}\n`)).toHaveLength(160)
  expect(specWhat('')).toBe('')
})

import { BAND_COLORS, bandOf } from './status'

test('bandOf: the state tag and colour per status, the count, the segments and the activity', () => {
  const agent = { id: 'a1', name: 'Implement task 3', model: 'claude-sonnet-5-5', status: 'running' as const, startedAt: NOW - 224_000, lastStepAt: NOW, calls: 3, tokens: 1, activity: 'running npm run lint', lastCommands: [], failures: 0 }
  const building = bandOf(item('p12', 'building', { title: 'x — Export' }), LEDGER, agent, NOW)
  expect(building).toMatchObject({ id: 'p12', title: 'Export', state: 'BUILDING', color: BAND_COLORS.running, count: 'Task 3 / 6', clock: '3:44', activity: 'Implementer · Sonnet 5.5 · running npm run lint' })
  expect(building.segments).toEqual(['accepted', 'accepted', 'current', 'pending', 'pending', 'pending'])
  expect(building.summary).toBe('2 accepted · 1 running')
  expect(building.tasks[2]).toEqual({ title: 'The route', segment: 'current' })
  expect(bandOf(item('p12', 'review'), LEDGER, undefined, NOW)).toMatchObject({ state: 'REVIEW', color: BAND_COLORS.running, clock: '—', activity: 'fix round 2 dispatched', summary: '2 accepted · 1 in review' })
  expect(bandOf(item('p12', 'planning'), null, undefined, NOW)).toMatchObject({ state: 'PLANNING', count: '', segments: [], activity: 'Waiting for the next dispatch', summary: '0 accepted · 0 pending' })
  const blocked = bandOf(item('p12', 'blocked', { note: 'Lint check failed' }), { ...LEDGER, tasks: LEDGER.tasks.map(t => (t.n === 3 ? { ...t, status: 'blocked' as const } : t)) }, undefined, NOW)
  expect(blocked).toMatchObject({ state: 'BLOCKED', color: BAND_COLORS.blocked, count: 'Task 3 / 6', activity: 'Lint check failed', summary: '2 accepted · 1 blocked' })
  expect(blocked.segments[2]).toBe('blocked')
  const merged = bandOf(item('p12', 'merged', { pr: 'https://x/pull/35' }), { ...LEDGER, resume: undefined, tasks: LEDGER.tasks.map(t => ({ ...t, status: 'accepted' as const })) }, undefined, NOW)
  expect(merged).toMatchObject({ state: 'MERGED', color: BAND_COLORS.merged, count: '6 / 6 accepted', activity: 'Merged · #35', summary: '6 accepted · merged' })
  expect(merged.segments.every(s => s === 'accepted')).toBe(true)
  expect(bandOf(item('p12', 'ready'), { ...LEDGER, resume: undefined, tasks: LEDGER.tasks.map(t => ({ ...t, status: 'pending' as const })) }, undefined, NOW)).toMatchObject({ state: 'READY', color: BAND_COLORS.idle, count: '6 tasks', activity: 'Next in queue · waiting to start', summary: '0 accepted · 6 pending' })
})

test('taskReview: a task accepted on the lead\'s reading of the diff ends its trail with a dim line saying so', () => {
  const accepted = { n: 3, title: 'c', status: 'accepted' as const, dispatches: [{ role: 'implementer' as const, model: 'claude-sonnet-5-5', effort: 'medium', tokens: 1, minutes: 2, result: 'done' }], review: { kind: 'lead-diff' as const, verdict: 'approved · taskReview off' } }
  expect(attemptsOf(accepted, 3, 'off').map(attemptText)).toEqual(['Build · Sonnet 5.5 · 2:00 ✓', 'review skipped (taskReview off)'])
  expect(attemptsOf(accepted, 3, 'risky').map(attemptText)).toEqual(['Build · Sonnet 5.5 · 2:00 ✓', 'lead read the diff'])
  expect(attemptsOf(accepted, 3).at(-1)).toMatchObject({ label: 'lead read the diff', isNote: true })
  expect(reviewNote(accepted, 'always')).toBe('lead read the diff')
  // An independent review, or a task not yet accepted, adds nothing.
  expect(attemptsOf({ ...accepted, review: { kind: 'independent', verdict: 'approved' } }, 3, 'off')).toHaveLength(1)
  expect(attemptsOf({ ...accepted, status: 'running' }, 3, 'off')).toHaveLength(1)
})

import type { AgentRun, Sibling } from '../types'
import { finishedOfTask, siblingLabel } from './status'

const agentRun = (name: string, startedAt: number, status: AgentRun['status'] = 'done'): AgentRun => ({ id: name, name, model: 'm', status, startedAt, lastStepAt: startedAt, endedAt: startedAt + 60_000, calls: 1, tokens: 1, activity: '', lastCommands: [], failures: 0 })

test('finishedOfTask: only the finished agents of the current task, named for it or started after its dispatch; every finished agent without a current task', () => {
  const at = Date.parse('2026-11-05T11:02:00Z')
  const ledger: Ledger = { ...LEDGER, resume: { task: 3, state: 'task 3 dispatched', at: new Date(at).toISOString() } }
  const agents = [agentRun('Implement task 1', at - 60 * 60_000), agentRun('Review task 2', at - 10 * 60_000, 'failed'), agentRun('Build the route for task 3', at - 60_000), agentRun('Explore the repo', at + 60_000), agentRun('Implement task 3', at + 120_000, 'running')]
  const current = ledger.tasks.find(t => t.n === 3)
  expect(finishedOfTask(agents, current, ledger).map(a => a.name)).toEqual(['Build the route for task 3', 'Explore the repo'])
  // A resume block of another task says nothing about when this one started: only the name counts.
  expect(finishedOfTask(agents, current, { ...ledger, resume: { task: 2, state: 'x', at: new Date(at).toISOString() } }).map(a => a.name)).toEqual(['Build the route for task 3'])
  // `task 3` is a word: task 30 is another task.
  expect(finishedOfTask([agentRun('Implement task 30', at - 60_000)], current, { ...ledger, resume: undefined }).map(a => a.name)).toEqual([])
  expect(finishedOfTask(agents, undefined, null).map(a => a.name)).toEqual(['Implement task 1', 'Review task 2', 'Build the route for task 3', 'Explore the repo'])
})

test('siblingLabel: a session with an item or agents by its title, item and agents; one with neither reads idle session · <title>, the folder name when the title is empty', () => {
  const sib = (over: Partial<Sibling>): Sibling => ({ sessionId: 's', title: 'catalo', cwd: '/p/catalo', seenAt: '2026-11-05T11:00:00Z', agents: [], signals: [], isStale: false, ...over })
  const running = agentRun('Implement task 2', NOW, 'running')
  expect(siblingLabel(sib({ title: 'p12 · Export', item: 'p12', agents: [running, agentRun('Review task 1', NOW)] }))).toEqual({ title: 'p12 · Export', meta: 'p12 · 1 agent', isIdle: false })
  expect(siblingLabel(sib({ item: 'p3', isStale: true }))).toEqual({ title: 'catalo', meta: 'p3 · 0 agents · stale', isIdle: false })
  expect(siblingLabel(sib({ agents: [agentRun('Explore', NOW)] }))).toEqual({ title: 'catalo', meta: '0 agents', isIdle: false })
  expect(siblingLabel(sib({}))).toEqual({ title: 'idle session · catalo', meta: '', isIdle: true })
  expect(siblingLabel(sib({ isStale: true }))).toEqual({ title: 'idle session · catalo', meta: 'stale', isIdle: true })
  expect(siblingLabel(sib({ title: '', cwd: 'C:\\work\\openhuddle\\' }))).toEqual({ title: 'idle session · openhuddle', meta: '', isIdle: true })
})
