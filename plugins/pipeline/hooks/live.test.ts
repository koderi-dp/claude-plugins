import { expect, test } from 'claude-code/testing'

import type { AgentRun, LiveEntry } from '../types'
import { DROP_MS, parseLive, siblingsOf, withEntry, withoutEntry } from './live'
import { STALE_MS } from './watch'

const T0 = Date.parse('2026-11-05T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const run: AgentRun = { id: 'tu1', agentId: 'a1', name: 'Implement', model: 'm', status: 'running', startedAt: T0, lastStepAt: T0, calls: 0, tokens: 0, activity: 'starting', lastCommands: [], failures: 0 }
const entry = (seenAt: number, extra: Record<string, unknown> = {}): LiveEntry => ({ title: 'csv export', cwd: '/p/main', startedAt: iso(T0), seenAt: iso(seenAt), agents: [run], signals: [], ...extra })

test('parseLive: empty, broken and foreign text give no sessions; entries keep their fields and unknown ones', () => {
  expect(parseLive('')).toEqual({ sessions: {} })
  expect(parseLive('{ not json')).toEqual({ sessions: {} })
  expect(parseLive('[1, 2]')).toEqual({ sessions: {} })
  expect(parseLive('{ "sessions": { "s1": 5 } }')).toEqual({ sessions: {} })
  const text = JSON.stringify({ colour: 'red', sessions: { s1: { ...entry(T0, { branch: 'feat/p12', item: 'p12', extra: 1 }), signals: [{ kind: 'silent', agent: 'Implement', detail: 'd', at: T0, delivered: false }] } } })
  const live = parseLive(text)
  expect(live['colour']).toBe('red')
  const s1 = live.sessions['s1']!
  expect(s1).toMatchObject({ title: 'csv export', cwd: '/p/main', branch: 'feat/p12', item: 'p12', extra: 1, startedAt: iso(T0), seenAt: iso(T0) })
  expect(s1.agents).toEqual([run])
  expect(s1.signals).toEqual([{ kind: 'silent', agent: 'Implement', detail: 'd', at: T0, delivered: false }])
  expect(parseLive('{ "sessions": { "s1": { "title": 3, "agents": "x" } } }').sessions['s1']).toMatchObject({ title: '', agents: [], signals: [] })
})

test('withEntry replaces this session, keeps the others and drops entries older than a day', () => {
  const now = T0 + 2 * DROP_MS
  const live = { note: 'kept', sessions: { old: entry(T0), other: entry(now - 1000), self: entry(T0) } }
  const next = withEntry(live, 'self', entry(now), now)
  expect(Object.keys(next.sessions)).toEqual(['other', 'self'])
  expect(next.sessions['self']!.seenAt).toBe(iso(now))
  expect(next['note']).toBe('kept')
  expect(live.sessions['old']).toBeDefined()
})

test('withoutEntry removes one session and leaves the rest', () => {
  const live = { sessions: { a: entry(T0), b: entry(T0) } }
  expect(Object.keys(withoutEntry(live, 'a').sessions)).toEqual(['b'])
  expect(Object.keys(withoutEntry(live, 'zzz').sessions)).toEqual(['a', 'b'])
})

test('siblingsOf: every other entry as a sibling, stale past three minutes, the excluded ids left out', () => {
  const now = T0 + 10 * 60_000
  const live = { sessions: { self: entry(now), fresh: entry(now - STALE_MS, { branch: 'feat/p12', item: 'p12', title: 'p12 · CSV export' }), old: entry(now - STALE_MS - 1), child: entry(now, { item: 'p3' }) } }
  const siblings = siblingsOf(live, 'self', now, ['child'])
  expect(siblings.map(s => s.sessionId)).toEqual(['fresh', 'old'])
  expect(siblings[0]).toEqual({ sessionId: 'fresh', title: 'p12 · CSV export', cwd: '/p/main', branch: 'feat/p12', item: 'p12', seenAt: iso(now - STALE_MS), agents: [run], signals: [], isStale: false })
  expect(siblings[1]).toMatchObject({ sessionId: 'old', isStale: true })
  expect(siblings[1]).not.toHaveProperty('branch')
  expect(siblingsOf(live, 'self', now)).toHaveLength(3)
  expect(siblingsOf({ sessions: { self: entry(now) } }, 'self', now)).toEqual([])
  expect(siblingsOf({ sessions: { bad: entry(now, { seenAt: 'yesterday' }) } }, 'self', now)[0]!.isStale).toBe(true)
})
