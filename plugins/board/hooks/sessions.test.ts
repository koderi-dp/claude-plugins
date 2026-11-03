import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MAIN = 'C:/p/main'
const LIVE = `${MAIN}/.git/board-live.json`
const NOW = Date.parse('2026-11-02T10:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

/** A main checkout at C:/p/main and this session in its worktree, files in memory. */
function world(on: On, seed: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>(Object.entries(seed))
  const key = (p: string) => p.split(String.fromCharCode(92)).join('/')
  on('fs.read', (_$, e) => {
    const t = files.get(key(e.path))
    return t === undefined ? { deny: `ENOENT: ${e.path}` } : { value: t }
  })
  on('fs.write', (_$, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.repo', () => ({ value: { root: MAIN, remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: 'C:/p/wt/q8' }))
  on('session.cwd', () => ({ value: 'C:/p/wt/q8' }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('prompt.submit', (_$, e) => e as never)
  return { clock, files, live: () => JSON.parse(files.get(LIVE) ?? '{"sessions":{}}') }
}

const start = ($: { session: { start: (e: never) => Promise<unknown> } }) =>
  $.session.start({ cwd: 'C:/p/wt/q8', surface: 'terminal', isInteractive: true } as never)

const other = (seenAt: string, title = 'Other') => ({ title, cwd: 'C:/p/wt/x', startedAt: seenAt, seenAt, agents: [] })

test('the session writes its entry at start and removes it at the end', async ($, on) => {
  const w = world(on, { 'C:/p/wt/q8/.git': 'gitdir: C:/p/main/.git/worktrees/q8\n', 'C:/p/main/.git/worktrees/q8/HEAD': 'ref: refs/heads/feat/q8-threads\n' })
  await start($)
  expect(w.live().sessions.self).toMatchObject({ title: 'feat/q8-threads', cwd: 'C:/p/wt/q8', branch: 'feat/q8-threads', seenAt: iso(0) })
  await $.session.end({ reason: 'other', sessionId: 'self' } as never)
  expect(w.live().sessions.self).toBeUndefined()
})

test('the title is the first prompt once there is one', async ($, on) => {
  const w = world(on)
  await start($)
  await $.prompt.submit({ text: 'Implement Q8 threads\nwith the plan', origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: 'and something else', origin: { kind: 'composer' } } as never)
  await w.clock.advance(3000)
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', usage: null })
  expect(w.live().sessions.self.title).toBe('Implement Q8 threads')
})

test("a heartbeat keeps another session's fresh entry and drops a stale one", async ($, on) => {
  const w = world(on, { [LIVE]: JSON.stringify({ sessions: { other: other(iso(60_000)), old: other(iso(2 * 3600_000), 'Old') } }) })
  await start($)
  await w.clock.advance(3000)
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', usage: null })
  expect(Object.keys(w.live().sessions).sort()).toEqual(['other', 'self'])
})

test('same-second writes keep both entries because each re-reads first', async ($, on) => {
  const w = world(on, { [LIVE]: JSON.stringify({ sessions: { other: other(iso(1000)) } }) })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  await start($)
  // Another session writes its own heartbeat between ours.
  const seen = w.live()
  seen.sessions.other.seenAt = iso(0)
  w.files.set(LIVE, JSON.stringify(seen))
  await $.agent.spawn({ tool_use_id: 't', prompt: 'p', description: 'Implement Task 2', subagentType: 'x', provider: 'engine', parentModel: 'm', background: false, fork: false } as never)
  const after = w.live()
  expect(Object.keys(after.sessions).sort()).toEqual(['other', 'self'])
  expect(after.sessions.other.seenAt).toBe(iso(0))
  expect(after.sessions.self.agents).toEqual([{ name: 'Implement Task 2', model: 'claude-opus-5-5', startedAt: iso(0), activity: 'starting' }])
})

test('marking an item in progress names it in the live entry, and get lists the other sessions', async ($, on) => {
  const w = world(on, { [LIVE]: JSON.stringify({ sessions: { other: other(iso(4 * 60_000)) } }) })
  await start($)
  await $.tool.call({ tool: 'mcp__board__board', action: 'update', milestones: [{ id: 'q8', title: 'Q8', status: 'active', items: [{ id: 't2', title: 'View', status: 'in_progress' }] }] } as never)
  expect(w.live().sessions.self.item).toBe('q8/t2')
  const got = JSON.parse(String(((await $.tool.call({ tool: 'mcp__board__board', action: 'get' } as never)) as { result: unknown }).result))
  expect(got.sessions).toEqual([expect.objectContaining({ id: 'other', title: 'Other', isQuiet: true })])
})

test('without a repository the live file goes under the home folder', async ($, on) => {
  const files = new Map<string, string>()
  mock.clock(on, { now: NOW })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', (_$, e) => {
    files.set(e.path.split(String.fromCharCode(92)).join('/'), e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.repo', () => ({ value: null }))
  on('session.root', () => ({ value: 'C:/scratch' }))
  on('session.cwd', () => ({ value: 'C:/scratch' }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/u' : undefined }))
  await start($)
  expect([...files.keys()].some(k => /^C:\/Users\/u\/\.claude\/board\/[0-9a-f]{12}\.json$/.test(k))).toBe(true)
})
