import { expect, test } from 'claude-code/testing'
import type { Backlog, Item } from '../types'

import { addItem, emptyBacklog, firstReady, moveItem, nextId, readiness, removeItem, renderBacklogMd, updateItem } from './backlog'

const NOW = '2026-11-05T10:00:00Z'
const item = (id: string, status: Item['status'], rest: Partial<Item> = {}): Item => ({ id, title: `Item ${id}`, status, ...rest })
const backlog = (...items: Item[]): Backlog => ({ version: 1, items })
const ids = (b: Backlog) => b.items.map(i => i.id)

test('emptyBacklog is version 1 with no items', () => {
  expect(emptyBacklog()).toEqual({ version: 1, items: [] })
})

test('nextId is p plus the smallest unused number', () => {
  expect(nextId(emptyBacklog())).toBe('p1')
  expect(nextId(backlog(item('p1', 'inbox'), item('p2', 'inbox')))).toBe('p3')
  expect(nextId(backlog(item('p1', 'inbox'), item('p3', 'inbox')))).toBe('p2')
  expect(nextId(backlog(item('x9', 'inbox'), item('p2', 'inbox')))).toBe('p1')
})

test('addItem appends with the next id, inbox status and the stamp, and leaves the input alone', () => {
  const before = backlog(item('p1', 'ready'))
  const after = addItem(before, { title: 'CSV export', size: 'M', needs: ['p1'] }, NOW)
  expect(ids(before)).toEqual(['p1'])
  expect(after.items[1]).toEqual({
    id: 'p2', title: 'CSV export', status: 'inbox', size: 'M', needs: ['p1'],
    source: '', spec: null, plan: null, branch: null, pr: null, ledger: null, note: '', updatedAt: NOW,
  })
})

test('addItem keeps a status and unknown fields the caller gives', () => {
  const after = addItem(emptyBacklog(), { title: 'Old', status: 'merged', pr: 'https://x/pull/3', owner: 'ana' }, NOW)
  expect(after.items[0]).toMatchObject({ id: 'p1', status: 'merged', pr: 'https://x/pull/3', owner: 'ana' })
})

test('updateItem merges fields, keeps unknown fields and stamps updatedAt only on a status change', () => {
  const before: Backlog = { version: 1, items: [{ ...item('p1', 'inbox', { updatedAt: '2026-01-01T00:00:00Z' }), owner: 'ana' }], colour: 'red' }
  const same = updateItem(before, 'p1', { note: 'hello' }, NOW)
  expect(same.items[0]).toMatchObject({ note: 'hello', owner: 'ana', updatedAt: '2026-01-01T00:00:00Z' })
  expect(same.colour).toBe('red')
  const moved = updateItem(before, 'p1', { status: 'ready', extra: 1 }, NOW)
  expect(moved.items[0]).toMatchObject({ status: 'ready', owner: 'ana', extra: 1, updatedAt: NOW })
  expect(before.items[0]?.status).toBe('inbox')
})

test('updateItem with an unknown id changes nothing', () => {
  const before = backlog(item('p1', 'inbox'))
  expect(updateItem(before, 'p9', { status: 'ready' }, NOW)).toEqual(before)
})

test('moveItem puts an item at the top or after another and preserves unknown fields', () => {
  const before: Backlog = { version: 1, items: [item('p1', 'inbox'), item('p2', 'inbox'), { ...item('p3', 'inbox'), owner: 'ana' }], tag: 1 }
  expect(ids(moveItem(before, 'p3', 'top'))).toEqual(['p3', 'p1', 'p2'])
  expect(ids(moveItem(before, 'p1', { after: 'p3' }))).toEqual(['p2', 'p3', 'p1'])
  expect(ids(moveItem(before, 'p3', { after: 'p1' }))).toEqual(['p1', 'p3', 'p2'])
  expect(moveItem(before, 'p3', 'top').items[0]).toMatchObject({ owner: 'ana' })
  expect(moveItem(before, 'p3', 'top').tag).toBe(1)
  expect(ids(moveItem(before, 'p9', 'top'))).toEqual(['p1', 'p2', 'p3'])
  expect(ids(moveItem(before, 'p1', { after: 'p9' }))).toEqual(['p1', 'p2', 'p3'])
  expect(ids(moveItem(before, 'p1', { after: 'p1' }))).toEqual(['p1', 'p2', 'p3'])
  expect(ids(before)).toEqual(['p1', 'p2', 'p3'])
})

test('removeItem drops the item and nothing else', () => {
  const before: Backlog = { version: 1, items: [item('p1', 'inbox'), item('p2', 'inbox')], tag: 1 }
  expect(removeItem(before, 'p1')).toEqual({ version: 1, items: [item('p2', 'inbox')], tag: 1 })
  expect(removeItem(before, 'p9')).toEqual(before)
})

const spec = (yes: string[]) => (i: Item) => yes.includes(i.id)
const none = () => false

test('readiness: ready when the spec exists and every need is merged', () => {
  const b = backlog(item('p9', 'merged'), item('p12', 'inbox', { needs: ['p9'] }), item('p13', 'ready'))
  const r = readiness({ backlog: b, specExists: spec(['p12', 'p13']), specHasOpen: none })
  expect(r).toEqual({ p12: { ready: true }, p13: { ready: true } })
})

test('readiness: a need that is not merged, is parked or does not exist, or an open question, blocks', () => {
  const b = backlog(
    item('p9', 'building'),
    item('p7', 'parked'),
    item('p1', 'inbox', { needs: ['p9'] }),
    item('p2', 'inbox', { needs: ['p7'] }),
    item('p3', 'ready', { needs: ['p99'] }),
    item('p4', 'inbox', { needs: [] }),
    item('p5', 'inbox'),
    item('p6', 'inbox', { needs: ['p9', 'p7'] }),
  )
  const r = readiness({ backlog: b, specExists: spec(['p1', 'p2', 'p3', 'p5', 'p6']), specHasOpen: i => i.id === 'p5' })
  expect(r['p1']).toEqual({ ready: false, reason: 'waits for p9' })
  expect(r['p2']).toEqual({ ready: false, reason: 'p7 is parked' })
  expect(r['p3']).toEqual({ ready: false, reason: 'p99 does not exist' })
  expect(r['p4']).toEqual({ ready: false, reason: 'no spec' })
  expect(r['p5']).toEqual({ ready: false, reason: 'open question in the spec' })
  expect(r['p6']).toEqual({ ready: false, reason: 'waits for p9' })
  expect(Object.keys(r).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
})

test('firstReady is the first ready item in array order, or null', () => {
  const b = backlog(item('p1', 'inbox', { needs: ['p9'] }), item('p2', 'ready'), item('p3', 'ready'))
  expect(firstReady({ backlog: b, specExists: spec(['p1', 'p2', 'p3']), specHasOpen: none })?.id).toBe('p2')
  expect(firstReady({ backlog: b, specExists: none, specHasOpen: none })).toBeNull()
})

test('renderBacklogMd has the sections in order, with rows, PR links and nothing else', () => {
  const b = backlog(
    item('p1', 'merged', { pr: 'https://github.com/x/y/pull/3', size: 'S' }),
    item('p2', 'building', { size: 'M', note: 'task 2 of 5' }),
    item('p3', 'ready', { needs: ['p1'] }),
    item('p4', 'inbox', { note: 'imported from docs/backlog.md, unverified' }),
    item('p5', 'blocked', { note: 'CI red' }),
    item('p6', 'parked'),
    item('p7', 'review', { pr: 'https://github.com/x/y/pull/8' }),
  )
  const md = renderBacklogMd(b)
  const headings = md.split('\n').filter(l => l.startsWith('## ')).map(l => l.slice(3))
  expect(headings).toEqual(['Active', 'Ready', 'Inbox', 'Blocked', 'Parked', 'Merged'])
  expect(md.split('\n')[0]).toMatch(/generated from backlog\.json/i)
  expect(md.split('\n')[0]).toMatch(/not edited by hand/)
  expect(md).toContain('| p2 | Item p2 | M | | task 2 of 5 |')
  expect(md).toContain('| p7 | Item p7 | | | https://github.com/x/y/pull/8 |')
  expect(md).toContain('| p3 | Item p3 | | p1 | |')
  expect(md).toContain('| p4 | Item p4 | | | imported from docs/backlog.md, unverified |')
  expect(md).toContain('| p1 | Item p1 | S | | https://github.com/x/y/pull/3 |')
  expect(md.indexOf('| p2 |')).toBeLessThan(md.indexOf('| p7 |'))
  expect(md.endsWith('\n')).toBe(true)
  const rows = md.split('\n').filter(l => /^\| p\d/.test(l))
  expect(rows).toHaveLength(7)
})

test('renderBacklogMd omits an empty section and shows an empty backlog', () => {
  const md = renderBacklogMd(backlog(item('p1', 'inbox')))
  expect(md).toContain('## Inbox')
  expect(md).not.toContain('## Merged')
  expect(md).not.toContain('## Active')
  expect(renderBacklogMd(emptyBacklog())).toContain('No items')
})
