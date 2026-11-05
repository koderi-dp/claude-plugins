import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { errorLine } from './register'

const MAIN = '/p/main'
const WORKTREE = '/p/wt/task-7'
const CONFIG = `${MAIN}/docs/pipeline/config.json`

/** A main checkout at /p/main, this session in its worktree, files in memory; records the plugin's state writes. */
function world(on: On, seed: Record<string, string> = {}, hasRepo = true) {
  const key = (p: string) => p.split(String.fromCharCode(92)).join('/')
  const commands: string[] = []
  const state = new Map<string, unknown>()
  on('fs.exists', (_$, e) => ({ value: key(e.path) in seed }))
  on('fs.read', (_$, e) => {
    const t = seed[key(e.path)]
    return t === undefined ? { deny: `ENOENT: ${e.path}` } : { value: t }
  })
  on('session.repo', () => ({ value: hasRepo ? { root: MAIN, remote: null, internal: false, name: null } : null }) as never)
  on('session.root', () => ({ value: WORKTREE }))
  on('session.cwd', () => ({ value: WORKTREE }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('state.set', async (_$, e, next) => {
    const r = await next(e)
    if ((e as { plugin: string }).plugin === 'pipeline') state.set((e as { key: string }).key, (e as { value: unknown }).value)
    return r
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  return { commands, state }
}

const start = ($: { session: { start: (e: never) => Promise<unknown> } }) =>
  $.session.start({ cwd: WORKTREE, surface: 'terminal', isInteractive: true } as never)

const VALID = JSON.stringify({ version: 1, mainBranch: 'main', branch: 'pipeline/{id}', checks: {}, merge: 'pr' }, null, 2) + '\n'

test('a project without docs/pipeline registers the command and leaves config null', async ($, on) => {
  const { commands, state } = world(on)
  await start($)
  expect(commands).toEqual(['pipeline'])
  expect(state.get('root')).toBe(MAIN)
  expect(state.get('config') ?? null).toBe(null)
  expect(state.get('fileError') ?? null).toBe(null)
})

test('a project with a valid config loads it from the main checkout', async ($, on) => {
  const { state } = world(on, { [CONFIG]: VALID })
  await start($)
  expect(state.get('config')).toMatchObject({ version: 1, mainBranch: 'main', merge: 'pr' })
  expect(state.get('fileError') ?? null).toBe(null)
})

test('a config with a syntax error sets fileError with its line and the session still starts', async ($, on) => {
  const { commands, state } = world(on, { [CONFIG]: '{\n  "version": 1,\n  "mainBranch": "main",\n  merge: "pr"\n}\n' })
  await start($)
  expect(commands).toEqual(['pipeline'])
  expect(state.get('config') ?? null).toBe(null)
  expect(state.get('fileError')).toMatch(/^docs\/pipeline\/config\.json: line \d+: /)
  // The line is the runtime's: 4 where it reports a position, 1 where it reports none.
  expect(state.get('fileError')).toMatch(/: line [14]: /)
})

test('errorLine takes the line from a position, a line, or answers 1', async () => {
  const text = '{\n  "version": 1,\n  "mainBranch": "main",\n  merge: "pr"\n}\n'
  expect(errorLine(text, 'Unexpected token m in JSON at position 44')).toBe(4)
  expect(errorLine(text, 'Expected double-quoted property name in JSON at position 44 (line 4 column 3)')).toBe(4)
  expect(errorLine(text, 'JSON Parse error: Property name must be a string literal')).toBe(1)
})

test('the session root is used without a repository', async ($, on) => {
  const { state } = world(on, {}, false)
  await start($)
  expect(state.get('root')).toBe(WORKTREE)
})

test('/pipeline answers a placeholder for now', async ($, on) => {
  world(on)
  const r = (await $.command.run({ command: 'pipeline', args: 'status', origin: { kind: 'composer' } } as never)) as { text?: string }
  expect(r.text).toBe('pipeline: not built yet')
})
