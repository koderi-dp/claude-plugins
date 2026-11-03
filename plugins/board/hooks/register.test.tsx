import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

function world(on: On, seed: Record<string, string> = {}) {
  mock.clock(on, { now: Date.parse('2026-11-02T10:00:00Z') })
  const key = (p: string) => p.split(String.fromCharCode(92)).join('/')
  on('fs.read', (_$, e) => {
    const t = seed[key(e.path)]
    return t === undefined ? { deny: 'ENOENT' } : { value: t }
  })
  on('fs.write', () => ({ value: undefined }))
  on('session.repo', () => ({ value: { root: 'C:/p/main', remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: 'C:/p/main' }))
  on('session.cwd', () => ({ value: 'C:/p/main' }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', () => ({ value: undefined }))
}

const run = async ($: { command: { run: (e: never) => Promise<unknown> } }, args: string) =>
  (await $.command.run({ command: 'board', args, origin: { kind: 'composer' } } as never)) as { text?: string; context?: readonly string[] }

test('the plugin registers its command', async ($, on) => {
  const names: string[] = []
  on('command.register', (_$, e) => {
    names.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  await $.session.start({ cwd: 'C:/p/main', surface: 'terminal', isInteractive: true } as never)
  expect(names).toContain('board')
})

test('/board init hands the model the init instructions', async ($, on) => {
  world(on)
  const r = await run($, 'init')
  expect(r.text).toMatch(/^Reading the plans/)
  expect(r.context?.[0]).toMatch(/docs\/superpowers\/plans/)
  expect(r.context?.[0]).toMatch(/backlog/)
  expect(r.context?.[0]).toMatch(/mcp__board__board/)
})

test('/board init on an existing board says it only refreshes', async ($, on) => {
  world(on, { 'C:/p/main/docs/superpowers/board.json': '{ "version": 1, "milestones": [] }\n' })
  const r = await run($, 'init')
  expect(r.text).toBe('A board exists; init refreshes titles, refs and queue fields and only proves statuses from git.')
  expect(r.context?.[0]).toMatch(/refresh/)
})
