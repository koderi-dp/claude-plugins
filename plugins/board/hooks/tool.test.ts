import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__board__board'
const MAIN = 'C:/p/main'
const BOARD = `${MAIN}/docs/superpowers/board.json`

/** A main checkout at C:/p/main and this session in its worktree C:/p/wt/task-7, files in memory. */
function world(on: On, seed: Record<string, string> = {}) {
  mock.clock(on, { now: Date.parse('2026-11-02T10:00:00Z') })
  const files = new Map<string, string>(Object.entries(seed))
  const writes: string[] = []
  // The engine hands these hooks the path in the platform's spelling.
  const key = (p: string) => p.split(String.fromCharCode(92)).join("/")
  on('fs.read', (_$, e) => {
    const t = files.get(key(e.path))
    return t === undefined ? { deny: `ENOENT: ${e.path}` } : { value: t }
  })
  on('fs.write', (_$, e) => {
    files.set(key(e.path), e.text)
    writes.push(key(e.path))
    return { value: undefined }
  })
  on('session.repo', () => ({ value: { root: MAIN, remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: 'C:/p/wt/task-7' }))
  on('session.cwd', () => ({ value: 'C:/p/wt/task-7' }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', () => ({ value: undefined }))
  return { files, writes }
}

const text = (r: unknown) => String((r as { result: unknown }).result)

test("update creates the board in the main checkout and answers the status text", async ($, on) => {
  const { files } = world(on)
  const r = await $.tool.call({
    tool: TOOL,
    action: 'update',
    milestones: [{ id: 'phase1', title: 'Phase 1', status: 'active', items: [{ id: 't1', title: 'A', status: 'in_progress' }] }],
  } as never)
  expect(text(r)).toContain('phase1 · Phase 1 · 0/1')
  expect([...files.keys()].filter(k => k.endsWith('board.json'))).toEqual([BOARD])
  expect(files.get(BOARD)).toMatch(/"updatedAt": "2026-11-02T10:00:00.000Z"/)
  expect(files.get(BOARD)?.endsWith('\n')).toBe(true)
})

test('a second update merges into what is on disk', async ($, on) => {
  const { files } = world(on)
  await $.tool.call({ tool: TOOL, action: 'update', milestones: [{ id: 'm', title: 'M', status: 'active', items: [{ id: 't1', title: 'A' }] }] } as never)
  files.set(BOARD, files.get(BOARD)!.replace('"title": "A"', '"title": "A edited elsewhere"'))
  await $.tool.call({ tool: TOOL, action: 'update', milestones: [{ id: 'm', items: [{ id: 't1', status: 'done' }] }] } as never)
  expect(JSON.parse(files.get(BOARD)!).milestones[0].items[0]).toMatchObject({ title: 'A edited elsewhere', status: 'done' })
})

test('a subagent call is ignored', async ($, on) => {
  const { writes } = world(on)
  const r = await $.tool.call({ tool: TOOL, action: 'update', milestones: [{ id: 'm', title: 'M' }], agentId: 'a1' } as never)
  expect(r).toMatchObject({ result: 'ignored: subagents do not write the board' })
  expect(writes).toEqual([])
})

test('bad JSON on disk refuses the write and names the line', async ($, on) => {
  const { writes, files } = world(on, { [BOARD]: '{\n  "version": 1,\n' })
  const r = await $.tool.call({ tool: TOOL, action: 'update', milestones: [{ id: 'm', title: 'M' }] } as never)
  expect(text(r)).toMatch(/^refused: line \d+: /)
  expect(writes).toEqual([])
  expect(files.get(BOARD)).toBe('{\n  "version": 1,\n')
  const got = await $.tool.call({ tool: TOOL, action: 'get' } as never)
  expect(text(got)).toMatch(/line \d+: /)
})

test('import reads the plan relative to the root', async ($, on) => {
  world(on, { [`${MAIN}/docs/superpowers/plans/2026-11-02-x.md`]: '# X plan\n### Task 1: One\n### Task 2: Two\n### Task 3: Three\n' })
  const r = await $.tool.call({ tool: TOOL, action: 'import', plan: 'docs/superpowers/plans/2026-11-02-x.md' } as never)
  expect(text(r)).toStartWith('imported 3 tasks into x\n')
  expect(text(r)).toContain('x · X plan · 0/3')
})

test('import in a worktree reads a plan only the worktree has, and writes the main board', async ($, on) => {
  const { files } = world(on, { 'C:/p/wt/task-7/docs/superpowers/plans/2026-11-02-q8.md': '# Q8\n### Task 1: Follow\n' })
  const r = await $.tool.call({ tool: TOOL, action: 'import', plan: 'docs/superpowers/plans/2026-11-02-q8.md' } as never)
  expect(text(r)).toStartWith('imported 1 tasks into q8\n')
  expect(JSON.parse(files.get(BOARD)!).milestones[0].ref).toBe('docs/superpowers/plans/2026-11-02-q8.md')
})

test('import of a missing plan refuses', async ($, on) => {
  const { writes } = world(on)
  const r = await $.tool.call({ tool: TOOL, action: 'import', plan: 'docs/superpowers/plans/nope.md' } as never)
  expect(text(r)).toBe('refused: cannot read docs/superpowers/plans/nope.md')
  expect(writes).toEqual([])
})

test('get on a missing file says it does not exist', async ($, on) => {
  world(on)
  const r = await $.tool.call({ tool: TOOL, action: 'get' } as never)
  expect(JSON.parse(text(r))).toMatchObject({ exists: false })
})
