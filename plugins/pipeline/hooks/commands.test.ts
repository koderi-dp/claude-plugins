import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseValue, setPath } from './register'

const TOOL = 'mcp__pipeline__pipeline'
const MAIN = '/p/main'
const DIR = `${MAIN}/docs/pipeline`
const CONFIG = `${DIR}/config.json`
const BACKLOG = `${DIR}/backlog.json`
const NOW = Date.parse('2026-11-05T10:00:00Z')

const VALID_CONFIG = JSON.stringify({ version: 1, mainBranch: 'main', branch: 'feat/<id>', checks: {}, merge: 'pr', colour: 'red' }, null, 2) + '\n'

type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }

/** A main checkout at /p/main, files in memory; `fs.list` answers from the file map's paths. */
function world(on: On, seed: Record<string, string> = {}) {
  clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>(Object.entries(seed))
  const writes: string[] = []
  const key = (p: string) => p.split(String.fromCharCode(92)).join('/')
  const under = (dir: string) => [...files.keys()].filter(k => k.startsWith(`${dir}/`)).map(k => k.slice(dir.length + 1))
  on('fs.exists', (_$, e) => {
    const p = key(e.path)
    return { value: files.has(p) || under(p).length > 0 }
  })
  on('fs.read', (_$, e) => {
    const t = files.get(key(e.path))
    return t === undefined ? { deny: `ENOENT: ${e.path}` } : { value: t }
  })
  on('fs.write', (_$, e) => {
    files.set(key(e.path), e.text)
    writes.push(key(e.path))
    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    const names = new Map<string, Entry>()
    for (const rest of under(key(e.path))) {
      const [name = '', ...more] = rest.split('/')
      if (!names.has(name)) names.set(name, { name, kind: more.length ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false })
    }
    return { value: [...names.values()] } as never
  })
  on('session.repo', () => ({ value: { root: MAIN, remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: MAIN }))
  on('session.cwd', () => ({ value: MAIN }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })
  return { files, writes, submitted }
}

type Answer = { text?: string; context?: readonly string[] }
// A prompt the command submits goes out from a timer after the hook returns; the mock clock runs it.
let clock: { advance: (ms: number) => Promise<void> } | null = null
const run = async ($: { command: { run: (e: never) => Promise<unknown> } }, args: string) => {
  const answer = (await $.command.run({ command: 'pipeline', args, origin: { kind: 'composer' } } as never)) as Answer
  if (clock) await clock.advance(100)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  return answer
}
const call = async ($: { tool: { call: (e: never) => Promise<unknown> } }, input: Record<string, unknown>) => String(((await $.tool.call({ tool: TOOL, ...input } as never)) as { result: unknown }).result)

const item = (id: string, title: string, status: string, extra: Record<string, unknown> = {}) => ({ id, title, status, size: 'M', updatedAt: '2026-11-05T09:00:00Z', ...extra })
const backlogOf = (items: Record<string, unknown>[]) => JSON.stringify({ version: 1, items }, null, 2) + '\n'

test('/pipeline status answers the same text as the tool, and status <id> the ledger', async ($, on) => {
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: backlogOf([item('p1', 'Login', 'ready'), item('p2', 'Export', 'inbox')]) })
  const viaCommand = await run($, 'status')
  expect(viaCommand.text).toBe(await call($, { action: 'status' }))
  expect(viaCommand.text).toContain('pipeline: 2 items · 1 ready')
  expect(viaCommand.context).toBeUndefined()
  expect((await run($, 'status p2')).text).toBe(await call($, { action: 'status', id: 'p2' }))
  expect((await run($, 'status p9')).text).toBe('no item p9')
})

test('/pipeline config prints the file; key=value writes it and keeps unknown keys; a wrong value is refused with the allowed ones', async ($, on) => {
  const { files, writes } = world(on, { [CONFIG]: VALID_CONFIG })
  expect((await run($, 'config')).text).toBe(VALID_CONFIG.trimEnd())
  expect((await run($, 'config merge=auto')).text).toBe('merge = "auto"')
  expect(writes).toEqual([CONFIG])
  const written = JSON.parse(files.get(CONFIG)!)
  expect(written).toMatchObject({ merge: 'auto', colour: 'red', mainBranch: 'main' })
  expect(files.get(CONFIG)?.endsWith('\n')).toBe(true)
  const refused = (await run($, 'config merge=sometimes')).text ?? ''
  expect(refused).toMatch(/^refused: merge: expected "auto" or "pr", got "sometimes"/)
  expect(writes).toEqual([CONFIG])
  expect(JSON.parse(files.get(CONFIG)!).merge).toBe('auto')
  expect((await run($, 'config mrege=pr')).text).toMatch(/^refused: no config key mrege; the keys are mainBranch, /)
  expect((await run($, 'config notify')).text).toMatch(/config takes key=value/)
})

test('/pipeline config parses dotted keys, numbers, booleans and arrays, and refuses a wrong type', async ($, on) => {
  const { files } = world(on, { [CONFIG]: VALID_CONFIG })
  expect((await run($, 'config limits.fixRounds=4')).text).toBe('limits.fixRounds = 4')
  expect((await run($, 'config retain.briefs=true')).text).toBe('retain.briefs = true')
  expect((await run($, 'config riskyPaths=["src/auth/**"]')).text).toBe('riskyPaths = ["src/auth/**"]')
  expect((await run($, 'config checks.gate=npm run check && npm test')).text).toBe('checks.gate = "npm run check && npm test"')
  expect(JSON.parse(files.get(CONFIG)!)).toMatchObject({ limits: { fixRounds: 4 }, retain: { briefs: true }, riskyPaths: ['src/auth/**'], checks: { gate: 'npm run check && npm test' } })
  expect((await run($, 'config limits.fixRounds=many')).text).toMatch(/^refused: limits\.fixRounds: expected a number, got string/)
  expect((await run($, 'config retain.plans=yes')).text).toMatch(/^refused: retain\.plans: expected a boolean, got string/)
  expect((await run($, 'config models.final.effort=huge')).text).toMatch(/^refused: models\.final\.effort: expected one of low, medium, high, xhigh, max, default/)
  expect((await run($, 'config taskReview=off')).text).toBe('taskReview = "off"')
  expect(JSON.parse(files.get(CONFIG)!).taskReview).toBe('off')
  expect((await run($, 'config taskReview=sometimes')).text).toMatch(/^refused: taskReview: expected "risky", "always" or "off", got "sometimes"/)
  expect(JSON.parse(files.get(CONFIG)!).taskReview).toBe('off')
})

test('/pipeline config without a config says so and writes nothing', async ($, on) => {
  const { writes } = world(on)
  expect((await run($, 'config merge=pr')).text).toBe('pipeline: no config (run /pipeline init)')
  expect(writes).toEqual([])
})

test('/pipeline config with a config that does not parse names the line and writes nothing', async ($, on) => {
  const { writes } = world(on, { [CONFIG]: '{\n  "version": 1,\n  merge: "pr"\n}\n' })
  expect((await run($, 'config merge=pr')).text).toMatch(/^pipeline: docs\/pipeline\/config\.json: line \d+: /)
  expect(writes).toEqual([])
})

test('the prompts: each submits a turn that names its skill and its first tool call', async ($, on) => {
  const { submitted } = world(on, { [CONFIG]: VALID_CONFIG })
  const last = () => submitted[submitted.length - 1] ?? ''
  const add = await run($, 'add csv export of catalogs')
  expect(add.text).toContain('intake')
  expect(add.context).toBeUndefined()
  expect(submitted).toHaveLength(1)
  expect(last()).toContain('pipeline-intake')
  expect(last()).toContain('"csv export of catalogs"')
  expect(last()).toContain(`${TOOL} {"action":"get","titles":true}`)
  await run($, 'add')
  expect(submitted).toHaveLength(1)

  await run($, 'next')
  expect(last()).toContain('pipeline-run')
  expect(last()).toContain('run the first ready item')
  await run($, 'run p12')
  expect(last()).toContain('run item p12')
  await run($, 'run all')
  expect(last()).toContain('until none is left')
  const before = submitted.length
  await run($, 'run')
  expect(submitted).toHaveLength(before)
  await run($, 'migrate')
  expect(last()).toContain('pipeline-migrate')
  expect(last()).toContain(`${TOOL} {"action":"migrate"}`)
  await run($, 'init')
  expect(last()).toContain(`${TOOL} {"action":"init"}`)
  expect(last()).toContain('pipeline-migrate')
  await run($, 'stop')
  expect(last()).toContain('pipeline-run')
  expect(last()).toMatch(/Finish the task that is running/)
  expect(last()).toMatch(/branch pushed and the ledger current/)
  expect(last()).toContain('"resume"')
  await run($, 'clean')
  expect(last()).toContain(`${TOOL} {"action":"clean"}`)
  expect(last()).toContain('git rm -r')
  expect(last()).toContain('mainBranch')
  expect((await (async () => { await run($, 'move p3 top'); return last() })())).toContain('{"action":"move","id":"p3","to":"top"}')
  expect((await (async () => { await run($, 'move p3 after p5'); return last() })())).toContain('{"action":"move","id":"p3","to":{"after":"p5"}}')
  expect((await run($, 'move p3')).context).toBeUndefined()
  expect((await (async () => { await run($, 'park p3'); return last() })())).toContain('{"action":"park","id":"p3"}')
  expect((await (async () => { await run($, 'unpark p3'); return last() })())).toContain('{"action":"unpark","id":"p3"}')
  expect((await run($, 'park')).context).toBeUndefined()
  expect((await run($, 'dance')).text).toMatch(/^pipeline: status \[id\] \| panel \| config/)
  expect((await run($, '')).text).toMatch(/^pipeline: status/)
})

const CLEAN_SEED = {
  [CONFIG]: JSON.stringify({ version: 1, mainBranch: 'main', branch: 'feat/<id>', checks: {}, merge: 'pr', retain: { plans: false, briefs: false, superpowers: false } }, null, 2) + '\n',
  [BACKLOG]: backlogOf([item('p1', 'Login', 'merged', { pr: '#3' }), item('p2', 'Export', 'building', { plan: 'docs/pipeline/plans/p2.md' }), item('p3', 'Search', 'merged', { plan: 'docs/superpowers/plans/2026-11-01-search.md' })]),
  [`${DIR}/ledgers/p1.json`]: '{}',
  [`${DIR}/ledgers/p1/task-1-brief.md`]: 'brief',
  [`${DIR}/ledgers/p2/task-1-brief.md`]: 'brief',
  [`${DIR}/plans/p1.md`]: 'plan',
  [`${DIR}/plans/p2.md`]: 'plan',
  [`${MAIN}/docs/superpowers/plans/2026-11-01-search.md`]: 'plan',
  [`${MAIN}/.superpowers/sdd/2026-10-30-p1-login/progress.md`]: 'x',
  [`${MAIN}/.superpowers/sdd/2026-11-01-search/plan-path`]: 'docs/superpowers/plans/2026-11-01-search.md\n',
  [`${MAIN}/.superpowers/sdd/2026-11-02-export/plan-path`]: 'docs/pipeline/plans/p2.md\n',
  [`${MAIN}/.claude/worktrees/p3/.git`]: 'gitdir: x',
  [`${MAIN}/.claude/worktrees/p2/.git`]: 'gitdir: x',
}

test('the clean tool action lists the paths from the folders on disk and deletes nothing', async ($, on) => {
  const { writes } = world(on, CLEAN_SEED)
  expect(await call($, { action: 'clean', item: 'p1' })).toBe(['docs/pipeline/ledgers/p1/', 'docs/pipeline/plans/p1.md', '.superpowers/sdd/2026-10-30-p1-login/'].join('\n'))
  expect(await call($, { action: 'clean', item: 'p3' })).toBe(['docs/superpowers/plans/2026-11-01-search.md', '.superpowers/sdd/2026-11-01-search/', '.claude/worktrees/p3/'].join('\n'))
  expect(await call($, { action: 'clean' })).toBe(
    ['docs/pipeline/ledgers/p1/', 'docs/pipeline/plans/p1.md', '.superpowers/sdd/2026-10-30-p1-login/', 'docs/superpowers/plans/2026-11-01-search.md', '.superpowers/sdd/2026-11-01-search/', '.claude/worktrees/p3/'].join('\n'),
  )
  expect(await call($, { action: 'clean', item: 'p2' })).toBe('refused: p2 is building, not merged')
  expect(await call($, { action: 'clean', item: 'p9' })).toBe('refused: no item p9')
  expect(writes).toEqual([])
})

test('the clean tool action answers nothing to clean when retain keeps everything', async ($, on) => {
  world(on, { ...CLEAN_SEED, [CONFIG]: JSON.stringify({ version: 1, retain: { plans: true, briefs: true, superpowers: true } }) + '\n' })
  expect(await call($, { action: 'clean', item: 'p1' })).toBe('nothing to clean')
})

test('the clean tool action answers nothing to clean when nothing is on disk', async ($, on) => {
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: backlogOf([item('p1', 'Login', 'merged')]) })
  expect(await call($, { action: 'clean' })).toBe('nothing to clean')
})

test('parseValue and setPath', async () => {
  expect(parseValue('4')).toBe(4)
  expect(parseValue('true')).toBe(true)
  expect(parseValue('false')).toBe(false)
  expect(parseValue('[1, "a"]')).toEqual([1, 'a'])
  expect(parseValue('[not json')).toBe('[not json')
  expect(parseValue('feat/<id>')).toBe('feat/<id>')
  expect(setPath({ a: 1 }, 'b.c', 2)).toEqual({ a: 1, b: { c: 2 } })
  expect(setPath({ a: { x: 1 } }, 'a.y', 2)).toEqual({ a: { x: 1, y: 2 } })
  expect(setPath({ a: 'text' }, 'a.y', 2)).toEqual({ a: { y: 2 } })
})
