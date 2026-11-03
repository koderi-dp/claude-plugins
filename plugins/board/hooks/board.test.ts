import { expect, test } from 'claude-code/testing'

import type { Board, Live, Milestone } from '../types'
import { CATALO_PLAN } from './fixtures/catalo-plan'
import { anchorOf, applyUpdate, attention, emptyBoard, findText, importPlan, parseBoard, serialize, statusText } from './board'

const PLAN = 'docs/superpowers/plans/2026-10-29-phase1-foundation.md'
const NO_LIVE: Live = { sessions: {} }
const AT = Date.parse('2026-11-02T10:12:00Z')

const ms = (id: string, status: Milestone['status'], items: Milestone['items'] = [], extra: Partial<Milestone> = {}): Milestone => ({
  id,
  title: `Title ${id}`,
  status,
  items,
  ...extra,
})

test('parseBoard reports the line of bad JSON', () => {
  const r = parseBoard('{\n  "version": 1,\n  "milestones": [\n')
  expect(r).toMatchObject({ ok: false })
  expect((r as { error: string }).error).toMatch(/^line \d+: /)
})

test('parseBoard names the line where the JSON breaks', () => {
  const r = parseBoard('{\n  "version": 1,\n  "milestones": [ x ]\n}\n')
  expect((r as { error: string }).error).toMatch(/^line 3: /)
})

test('parseBoard refuses JSON that is not a board', () => {
  expect(parseBoard('[1, 2]')).toMatchObject({ ok: false })
  expect(parseBoard('{ "version": 1, "milestones": [] }')).toMatchObject({ ok: true })
})

test('applyUpdate merges by id, stamps updatedAt on a status change and keeps unknown fields', () => {
  const b = {
    version: 1 as const,
    milestones: [{ id: 'm', title: 'M', status: 'active' as const, extra: 1, items: [{ id: 't1', title: 'A', status: 'backlog' as const, colour: 'red' }] }],
  }
  const r = applyUpdate(
    b,
    { milestones: [{ id: 'm', items: [{ id: 't1', status: 'in_progress', note: 'go' }, { id: 't2', title: 'B', status: 'next', after: 't1' }] }] },
    '2026-11-02T10:00:00Z',
  )
  expect(r.milestones[0]).toMatchObject({ extra: 1 })
  expect(r.milestones[0].items[0]).toMatchObject({ colour: 'red', status: 'in_progress', note: 'go', updatedAt: '2026-11-02T10:00:00Z' })
  expect(r.milestones[0].items.map(i => i.id)).toEqual(['t1', 't2'])
  expect(r.milestones[0].items[1]).not.toHaveProperty('after')
  expect(b.milestones[0].items[0].status).toBe('backlog')
})

test('applyUpdate leaves updatedAt alone when only the note changes, and remove drops ids', () => {
  const b: Board = {
    version: 1,
    milestones: [ms('m', 'active', [{ id: 't1', title: 'A', status: 'done', updatedAt: 'old' }, { id: 't2', title: 'B', status: 'next' }])],
  }
  const r = applyUpdate(b, { milestones: [{ id: 'm', items: [{ id: 't1', status: 'done', note: 'a1..b2' }] }] }, 'new')
  expect(r.milestones[0].items[0]).toMatchObject({ updatedAt: 'old', note: 'a1..b2' })
  expect(applyUpdate(r, { remove: ['t2'] }, 'new').milestones[0].items.map(i => i.id)).toEqual(['t1'])
  expect(applyUpdate(r, { remove: ['m'] }, 'new').milestones).toEqual([])
})

test('applyUpdate places a new milestone after another and replaces the goal whole', () => {
  const b: Board = { version: 1, goal: { title: 'MVP', done: 1, total: 9 }, milestones: [ms('a', 'done'), ms('c', 'planned')] }
  const r = applyUpdate(b, { goal: { title: 'MVP rows', done: 2, total: 9 }, milestones: [{ id: 'b', title: 'B', after: 'a' }] }, 'now')
  expect(r.milestones.map(m => m.id)).toEqual(['a', 'b', 'c'])
  expect(r.milestones[1]).toMatchObject({ status: 'planned', items: [] })
  expect(r.goal).toEqual({ title: 'MVP rows', done: 2, total: 9 })
})

test("importPlan reads catalo's nine tasks from CRLF text and keeps existing statuses", () => {
  const first = importPlan(emptyBoard(), { plan: PLAN, text: CATALO_PLAN })
  expect(first).toMatchObject({ ok: true, milestoneId: 'phase1-foundation', count: 9 })
  const b = (first as { board: Board }).board
  expect(b.milestones[0]).toMatchObject({ status: 'active', title: 'Phase 1, Plan 1: Foundation Implementation Plan', ref: PLAN })
  expect(b.milestones[0].items).toHaveLength(9)
  expect(b.milestones[0].items[2]).toMatchObject({
    id: 't3',
    title: 'Croatian and English UI with Paraglide',
    status: 'backlog',
    ref: `${PLAN}#task-3-croatian-and-english-ui-with-paraglide`,
  })
  expect(b.milestones[0].items.every(i => !/\s$/.test(i.title))).toBe(true)
  const marked = applyUpdate(b, { milestones: [{ id: 'phase1-foundation', items: [{ id: 't3', status: 'done', note: 'a..b' }] }] }, '2026-11-02T10:00:00Z')
  const again = importPlan(marked, { plan: PLAN, text: CATALO_PLAN.replace('Croatian and English UI', 'Croatian + English UI') })
  expect((again as { board: Board }).board.milestones[0].items[2]).toMatchObject({ status: 'done', note: 'a..b', title: 'Croatian + English UI with Paraglide' })
})

test('importPlan adds a second plan as planned with the queue fields given', () => {
  const one = (importPlan(emptyBoard(), { plan: PLAN, text: CATALO_PLAN }) as { board: Board }).board
  const r = importPlan(one, {
    plan: 'docs/superpowers/plans/2026-11-02-q8-threads.md',
    text: '# Q8\n### Task 1: Follow\n### Task 2: View\n',
    milestone: { id: 'q8', needs: ['q7'], size: 'M' },
  })
  expect(r).toMatchObject({ ok: true, milestoneId: 'q8', count: 2 })
  expect((r as { board: Board }).board.milestones[1]).toMatchObject({ id: 'q8', status: 'planned', needs: ['q7'], size: 'M', title: 'Q8' })
})

test('importPlan without task headings fails and changes nothing', () => {
  const r = importPlan(emptyBoard(), { plan: 'x.md', text: '# Nothing\nno tasks' })
  expect(r).toMatchObject({ ok: false })
  expect((r as { error: string }).error).toBe('no "### Task N:" headings in x.md')
})

test('anchorOf makes GitHub-style anchors', () => {
  expect(anchorOf('Task 2: Domain package: search keys, prices and barcodes')).toBe('task-2-domain-package-search-keys-prices-and-barcodes')
})

test('serialize is two-space JSON with a trailing newline', () => {
  const s = serialize(emptyBoard())
  expect(s.endsWith('\n')).toBe(true)
  expect(s.split('\n')[1]).toMatch(/^ {2}"/)
})

test('statusText with no board says how to make one, and with a goal shows it', () => {
  expect(statusText(null, null, NO_LIVE, [], [], AT)).toStartWith('No board. /board init reads the plans and the ledger.')
  expect(statusText(null, 'line 2: Unexpected end', NO_LIVE, [], [], AT)).toStartWith('Board: line 2: Unexpected end')
  const b: Board = { version: 1, goal: { title: 'MVP rows on main', done: 21, total: 36 }, milestones: [ms('q8', 'active', [{ id: 't1', title: 'A', status: 'done' }])] }
  const text = statusText(b, null, NO_LIVE, [], [], AT)
  expect(text).toStartWith('Board · MVP rows on main 21/36')
  expect(text).toContain('  ● q8 · Title q8 · 1/1')
  expect(text).toContain('Now')
})

test('statusText folds planned milestones after 4 and lists all with scope all', () => {
  const planned = Array.from({ length: 6 }, (_, i) =>
    ms(`p${i}`, 'planned', [{ id: 't1', title: `Item p${i}`, status: 'backlog' }], i === 0 ? { needs: ['q7'], size: 'M' } : {}),
  )
  const b: Board = { version: 1, milestones: [ms('a', 'active', [{ id: 't1', title: 'Doing', status: 'in_progress' }]), ...planned, ms('d1', 'done'), ms('d2', 'done')] }
  const text = statusText(b, null, NO_LIVE, [], [], AT)
  expect(text).toStartWith('Board · 0/7 done')
  expect(text).toContain('  ○ p0 · Title p0 · 0/1 · needs q7 · M')
  expect(text).toContain('  … and 2 more planned')
  expect(text).toContain('  ✓ 2 milestones, latest: Title d2')
  expect(text).not.toContain('Item p5')
  const all = statusText(b, null, NO_LIVE, [], [], AT, 'all')
  expect(all).not.toContain('more planned')
  expect(all).toContain('Item p5')
  expect(all).toContain('Title d1')
})

test('statusText with a milestone id prints that milestone in full with what it closes', () => {
  const b: Board = {
    version: 1,
    milestones: [
      ms('q8', 'active', [{ id: 't2', title: 'Threads view', status: 'in_progress', note: 'round 1', updatedAt: '2026-11-02T10:00:00Z' }], { closes: ['18 Thread following'] }),
      ms('q9', 'planned'),
    ],
  }
  const text = statusText(b, null, NO_LIVE, [], [], AT, 'q8')
  expect(text).toContain('t2 · Threads view · in_progress · 12m · round 1')
  expect(text).toContain('18 Thread following')
  expect(text).not.toContain('q9')
  expect(statusText(b, null, NO_LIVE, [], [], AT, 'zz')).toContain('No milestone zz')
})

test('statusText lists running and finished agents, tasks and other sessions under Now', () => {
  const agents = [
    { id: 'a1', name: 'Review Task 6', model: 'claude-opus-5-5', status: 'running' as const, startedAt: AT - 347_000, calls: 3, activity: 'running npm run dev' },
    { id: 'a2', name: 'Implement Task 6', model: 'claude-opus-5-5', status: 'done' as const, startedAt: AT - 2_000_000, endedAt: AT - 620_000, calls: 43, activity: 'x' },
  ]
  const tasks = [
    { id: '1', subject: 'A', status: 'in_progress' as const },
    { id: '2', subject: 'B', status: 'pending' as const },
  ]
  const live: Live = {
    sessions: {
      s1: {
        title: 'Implement Q8 threads',
        cwd: 'C:/wt',
        branch: 'feat/q8',
        item: 'q8/t2',
        startedAt: '2026-11-02T10:00:00Z',
        seenAt: '2026-11-02T10:11:00Z',
        agents: [{ name: 'x', model: 'opus', startedAt: '2026-11-02T10:01:00Z', activity: 'editing following.tsx' }],
      },
    },
  }
  const text = statusText(null, null, live, agents, tasks, AT)
  expect(text).toContain('  tasks: 1 in progress, 1 pending')
  expect(text).toContain('  ● Review Task 6 · opus · 5m · running npm run dev')
  expect(text).toContain('  ✓ Implement Task 6 · 23m · 43 calls')
  expect(text).toContain('  sessions: Implement Q8 threads · feat/q8 · q8/t2 · 1 agent · editing following.tsx')
})

test('attention prefers blocked over in_progress over next', () => {
  const blocked = ms('a', 'active', [
    { id: 't1', title: 'A', status: 'in_progress' },
    { id: 't2', title: 'B', status: 'blocked', note: 'WIP commit on task-7' },
  ])
  expect(attention(blocked, NO_LIVE)).toEqual({ kind: 'blocked', count: 1, text: '1 blocked: WIP commit on task-7' })
  const live: Live = {
    sessions: { s: { title: 'S', cwd: '', item: 'b/t1', startedAt: '', seenAt: '', agents: [{ name: 'n', model: 'claude-opus-5-5', startedAt: '2026-11-02T10:00:00Z', activity: '' }] } },
  }
  const going = ms('b', 'active', [{ id: 't1', title: 'Threads I follow view', status: 'in_progress' }])
  expect(attention(going, live, AT)).toMatchObject({ kind: 'in_progress', count: 1, text: '1 in progress: Threads I follow view · opus · 12m' })
  const next = ms('c', 'active', [
    { id: 't1', title: 'A', status: 'done' },
    { id: 't2', title: 'Thread mute', status: 'next' },
  ])
  expect(attention(next, NO_LIVE)).toMatchObject({ kind: 'next', text: 'next: Thread mute' })
  expect(attention(ms('d', 'active', [{ id: 't1', title: 'A', status: 'done' }]), NO_LIVE)).toMatchObject({ kind: 'none' })
})

test('findText lists matching items with their milestone', () => {
  const b: Board = {
    version: 1,
    milestones: [
      ms('q8', 'active', [
        { id: 't2', title: 'Threads I follow view', status: 'in_progress' },
        { id: 't3', title: 'Mute', status: 'next', note: 'needs webhook' },
      ]),
      ms('q9', 'planned', [{ id: 't1', title: 'Webhook corpus', status: 'done' }]),
    ],
  }
  expect(findText(b, 'webhook').split('\n')).toEqual(['q8 · t3 · Mute · next', 'q9 · t1 · Webhook corpus · done'])
  expect(findText(b, 'zzz')).toBe('No items match "zzz".')
})
