import { expect, test } from 'claude-code/testing'

import type { Live, LiveSession } from '../types'
import { DROP_MS, QUIET_MS, boardPath, hash12, livePath, others, parseLive, titleOf, withEntry, withoutEntry } from './live'

const NOW = Date.parse('2026-11-02T12:00:00Z')
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const entry = (seenAt: string, title = 'S'): LiveSession => ({ title, cwd: 'C:/p', startedAt: seenAt, seenAt, agents: [] })

test('withEntry keeps the other session and drops one older than an hour', () => {
  const live: Live = { sessions: { other: entry(at(60_000), 'Other'), old: entry(at(61 * 60_000), 'Old') } }
  const r = withEntry(live, 'self', entry(at(0), 'Self'), NOW)
  expect(Object.keys(r.sessions).sort()).toEqual(['other', 'self'])
  expect(live.sessions.old).toBeDefined()
  expect(DROP_MS).toBe(60 * 60_000)
})

test('withoutEntry removes only that session', () => {
  const live: Live = { sessions: { a: entry(at(0)), b: entry(at(0)) } }
  expect(Object.keys(withoutEntry(live, 'a').sessions)).toEqual(['b'])
})

test('others marks quiet after 3 minutes and leaves self out', () => {
  const live: Live = { sessions: { self: entry(at(0)), other: entry(at(4 * 60_000), 'Other'), fresh: entry(at(10_000), 'Fresh') } }
  const r = others(live, 'self', NOW)
  expect(r.map(o => o.id)).toEqual(['fresh', 'other'])
  expect(r[0].isQuiet).toBe(false)
  expect(r[1]).toMatchObject({ id: 'other', title: 'Other', isQuiet: true })
  expect(QUIET_MS).toBe(3 * 60_000)
})

test('parseLive tolerates garbage', () => {
  expect(parseLive('nope')).toEqual({ sessions: {} })
  expect(parseLive('{"sessions": [1]}')).toEqual({ sessions: {} })
  expect(parseLive('{"sessions": {"a": 3, "b": {"title": "B", "seenAt": "x"}}}').sessions).toEqual({ b: { title: 'B', cwd: '', startedAt: '', seenAt: 'x', agents: [] } })
})

test('paths: repo and no repo', () => {
  expect(boardPath('C:/p/x')).toBe('C:/p/x/docs/superpowers/board.json')
  expect(boardPath('C:\\p\\x\\')).toBe('C:/p/x/docs/superpowers/board.json')
  expect(livePath('C:/p/x', true, 'C:/Users/u')).toBe('C:/p/x/.git/board-live.json')
  expect(livePath('C:/p/x', false, 'C:/Users/u')).toMatch(/^C:\/Users\/u\/\.claude\/board\/[0-9a-f]{12}\.json$/)
  expect(hash12('C:/p/x')).toBe(hash12('C:/p/x'))
  expect(hash12('C:/p/x')).not.toBe(hash12('C:/p/y'))
})

test('titleOf cuts to 60 characters and falls back to the branch', () => {
  const t = titleOf('x'.repeat(70), 'feat/x')
  expect(t).toHaveLength(60)
  expect(t.endsWith('…')).toBe(true)
  expect(titleOf('First line\nsecond line', null)).toBe('First line')
  expect(titleOf(null, 'feat/x')).toBe('feat/x')
  expect(titleOf('   ', null)).toBe('session')
  expect(titleOf(null, null)).toBe('session')
})
