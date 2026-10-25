import { expect, test } from 'claude-code/testing'

import { classify, emptyProgress, etaMs, formatDuration, mergeTasks, parseLedger, parsePlan, percent, testCounts } from './progress'

const ROOT = 'C:/repo'
const PLAN_PATH = `${ROOT}/.shipright/plans/2026-10-25-probe.md`
const LEDGER_PATH = `${ROOT}/.shipright/ledger.md`
const PLAN = [
  '# Probe mode plan',
  'Goal: x',
  '## Task 1: Agent capabilities',
  'Files: a',
  '## Task 2: Metrics collector',
  '## Task 3: Docker client',
].join('\n')

const PANE = {
  plugin: 'shipright',
  component: 'Pane',
  requestId: 'shipright-progress',
  props: {
    title: 'Shipright',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('reads tasks from lean and older plans, and finished tasks from the ledger', async () => {
  expect(parsePlan(PLAN)).toEqual({
    feature: 'Probe mode',
    gate: null,
    tasks: [
      { n: 1, title: 'Agent capabilities', check: null },
      { n: 2, title: 'Metrics collector', check: null },
      { n: 3, title: 'Docker client', check: null },
    ],
  })
  expect(parsePlan('# Old Implementation Plan\n### Task 7: Thing\n').tasks).toEqual([{ n: 7, title: 'Thing', check: null }])
  // Each task's Done check stays with its own task.
  const withChecks = '# P plan\n## Task 1: A\nDone: `node --test test/a.test.mjs` passes\n## Task 2: B\nTests: none\n## Task 3: C\nDone: `node --test` passes; in the browser, it loads\n'
  expect(parsePlan(withChecks).tasks.map(t => t.check)).toEqual(['node --test test/a.test.mjs', null, 'node --test'])
  expect([...parseLedger('## Task 1 caps - abc123\nProduced: x\n## Task 3 docker - def\n')]).toEqual([1, 3])
  // Ledgers from 0.1.4 on carry no commit hash.
  expect([...parseLedger('## Task 1 Pure todo state\nDeviated: none\n## Task 2 Storage\n')]).toEqual([1, 2])
})

test('classifies the tool calls a run makes and ignores the rest', async () => {
  expect(classify({ tool: 'Write', file_path: 'C:\\repo\\.shipright\\plans\\p.md' })).toEqual({
    kind: 'plan',
    root: 'C:/repo',
    path: 'C:\\repo\\.shipright\\plans\\p.md',
  })
  expect(classify({ tool: 'Edit', file_path: `${ROOT}/.shipright/ledger.md` })).toEqual({ kind: 'ledger', root: ROOT })
  expect(classify({ tool: 'Write', file_path: `${ROOT}/src/a.ts` })).toEqual({ kind: 'code', path: `${ROOT}/src/a.ts` })
  expect(classify({ tool: 'Bash', command: 'git switch -c feature/probe && git add .' })).toEqual({ kind: 'branch', name: 'feature/probe' })
  expect(classify({ tool: 'Bash', command: 'npm run check:release' })).toEqual({ kind: 'gate' })
  expect(classify({ tool: 'Bash', command: 'gh pr create --fill' })).toEqual({ kind: 'pr' })
  expect(classify({ tool: 'Agent', subagent_type: 'shipright:task-reviewer' })).toEqual({ kind: 'taskReview', model: null })
  expect(classify({ tool: 'Agent', subagent_type: 'shipright:final-reviewer', model: 'opus', effort: 'high' })).toEqual({
    kind: 'finalReview',
    model: 'opus high',
  })
  expect(classify({ tool: 'Agent', subagent_type: 'Explore' })).toBe(null)
  expect(classify({ tool: 'AskUserQuestion', questions: [{ question: 'Which model should do the final review?' }] })).toEqual({ kind: 'models' })
  expect(classify({ tool: 'AskUserQuestion', questions: [{ question: 'Keep going?' }] })).toBe(null)
  expect(classify({ tool: 'Bash', command: 'ls -la' })).toBe(null)
  expect(classify({ tool: 'Read', file_path: `${ROOT}/a.ts` })).toBe(null)
})

test('percent moves with tasks, never hits 100 before the PR, and the ETA uses the average task', async () => {
  const tasks = mergeTasks([], parsePlan(PLAN).tasks, new Set([1]), 60_000, true)
  expect(tasks.map(t => t.status)).toEqual(['done', 'active', 'pending'])
  const p = { ...emptyProgress(), phase: 'build' as const, tasks, buildStartedAt: 0 }
  expect(percent(p)).toBe(50)
  expect(percent({ ...p, phase: 'review' })).toBe(92)
  expect(percent({ ...p, phase: 'done' })).toBe(100)
  expect(etaMs(p, 60_000)).toBe(120_000)
  expect(etaMs({ ...p, tasks: mergeTasks([], parsePlan(PLAN).tasks, new Set(), 0, true) }, 60_000)).toBe(null)
})

test('reads test counts from common runners and formats short durations', async () => {
  expect(testCounts('ℹ tests 23\nℹ suites 0\nℹ pass 23\nℹ fail 0\n')).toBe('23/23')
  expect(testCounts('# tests 15\n# pass 14\n# fail 1\n')).toBe('14/15')
  expect(testCounts(' 6 pass\n 0 fail\nRan 6 tests across 1 file.')).toBe('6/6')
  expect(testCounts('Tests:       1 failed, 22 passed, 23 total')).toBe('22/23')
  expect(testCounts('Build succeeded')).toBe(null)
  expect(formatDuration(4_400)).toBe('4s')
  expect(formatDuration(252_000)).toBe('4m 12s')
  expect(formatDuration(3_900_000)).toBe('1h 05m')
})

test('the running task shows its steps with durations, and collapses to one timed line when done', async ($, on) => {
  const plan = [
    '# Probe mode plan',
    'Goal: x',
    'Gate: `node --test`',
    '## Task 1: Agent capabilities',
    'Done: `node --test test/caps.test.mjs` passes',
    '## Task 2: Metrics collector',
    'Done: `node --test test/metrics.test.mjs` passes',
  ].join('\n')
  let now = 0
  let ledger = ''
  on('clock.now', () => ({ value: now }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => {
    const path = e.path.replace(/\\/g, '/')
    if (path === PLAN_PATH) return { value: plan }
    if (path === LEDGER_PATH) return { value: ledger }
    throw new Error('ENOENT')
  })
  on('command.register', () => ({ value: { command: 'shipright-progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => {
    const command = String((e as { command?: unknown }).command ?? '')
    if (command.includes('caps.test')) return { result: {}, text: 'ℹ tests 1\nℹ pass 0\nℹ fail 1\n', isError: true }
    if (command.includes('metrics.test')) return { result: {}, text: 'ℹ tests 5\nℹ pass 5\nℹ fail 0\n' }
    if (command.includes('node --test')) return { result: {}, text: 'ℹ tests 9\nℹ pass 9\nℹ fail 0\n' }
    return { result: {} }
  })
  const lines = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const found = await ui.findAll({ type: 'Text' })
    await ui.unmount()
    return found.map(t => t.text)
  }

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: PLAN_PATH, content: plan })
  await $.tool.call({ tool: 'Bash', command: 'git switch -c feature/probe' })

  now = 10_000
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/caps.mjs`, content: 'x' })
  now = 20_000
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/test/caps.test.mjs`, content: 'x' })
  now = 70_000
  await $.tool.call({ tool: 'Bash', command: 'node --test test/caps.test.mjs' })
  now = 80_000
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/caps.mjs`, old_string: 'x', new_string: 'y' })
  now = 90_000
  let shown = await lines()
  expect(shown).toContain('▶ 1. Agent capabilities')
  expect(shown).toContain('1m 20s')
  // One code step for both files, the failed check with its count, then the fix still running.
  expect(shown).toContain('    ✓ code and tests')
  expect(shown).toContain('1m 00s')
  expect(shown).toContain('    ✗ check')
  expect(shown).toContain('0/1  0s')
  expect(shown).toContain('    ▶ fix')

  await $.tool.call({ tool: 'Agent', subagent_type: 'shipright:task-reviewer', model: 'sonnet', effort: 'low', prompt: 'p', description: 'd' })
  now = 120_000
  shown = await lines()
  expect(shown).toContain('◆ 1. Agent capabilities (review)')
  expect(shown).toContain('    ▶ review sonnet low')
  expect(shown).toContain('30s')

  ledger = '## Task 1 Agent capabilities\n'
  await $.tool.call({ tool: 'Edit', file_path: LEDGER_PATH, old_string: '', new_string: ledger })
  shown = await lines()
  expect(shown).toContain('✓ 1. Agent capabilities')
  expect(shown).toContain('1m 50s')
  expect(shown.some(s => s.includes('review sonnet'))).toBe(false)

  // Task 2: its check is a narrow one, so the plain gate command run mid-build is neither its check nor the gate.
  now = 130_000
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/metrics.mjs`, content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'node --test test/metrics.test.mjs' })
  shown = await lines()
  expect(shown).toContain('    ✓ check')
  expect(shown).toContain('5/5  0s')
  ledger += '## Task 2 Metrics collector\n'
  now = 200_000
  await $.tool.call({ tool: 'Bash', command: 'git add .shipright/ledger.md src test && git commit -m x' })

  now = 204_000
  await $.tool.call({ tool: 'Bash', command: 'node --test' })
  shown = await lines()
  expect(shown).toContain('▶ Release gate')
  expect(shown).toContain('0s  9/9')

  await $.tool.call({ tool: 'Agent', subagent_type: 'shipright:final-reviewer', model: 'opus', effort: 'high', prompt: 'p', description: 'd' })
  now = 330_000
  shown = await lines()
  expect(shown).toContain('▶ Final review')
  expect(shown).toContain('opus high  2m 06s')
  await $.tool.call({ tool: 'Bash', command: 'git merge --no-ff feature/probe' })
  now = 900_000
  shown = await lines()
  // The review's time stops when the session acts on it.
  expect(shown).toContain('opus high  2m 06s')
})

test('a run already under way is picked up from its ledger when the pane missed the plan', async ($, on) => {
  on('clock.now', () => ({ value: 5_000 }))
  on('fs.exists', (_, e) => ({ value: e.path.replace(/\\/g, '/') === `${ROOT}/.shipright/plans` }))
  on('fs.list', () => ({ value: [{ name: '2026-10-25-probe.md', kind: 'file', mtimeMs: 1 }] }))
  on('fs.read', (_, e) => {
    const path = e.path.replace(/\\/g, '/')
    if (path === PLAN_PATH) return { value: PLAN }
    if (path === LEDGER_PATH) return { value: '## Task 1 Agent capabilities - abc123\n' }
    throw new Error('ENOENT')
  })
  on('command.register', () => ({ value: { command: 'shipright-progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  // The session started in a parent folder, so restore on start finds nothing.
  await $.session.start({ cwd: 'C:/elsewhere', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: LEDGER_PATH, old_string: '', new_string: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Tasks / }))?.text).toBe('Tasks 1/3')
  expect((await ui.find({ type: 'Text', text: /^Task 2 of 3/ }))?.text).toBe('Task 2 of 3: building')
  await ui.unmount()
})

test('a run with a plain gate command and no remote reaches the gate and finishes on a local merge', async ($, on) => {
  const plan = PLAN.replace('Goal: x', 'Goal: x\nGate: `node --test`')
  let ledger = ''
  on('clock.now', () => ({ value: 1_000 }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => {
    const path = e.path.replace(/\\/g, '/')
    if (path === PLAN_PATH) return { value: plan }
    if (path === LEDGER_PATH) return { value: ledger }
    throw new Error('ENOENT')
  })
  on('command.register', () => ({ value: { command: 'shipright-progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  const text = async (pattern: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const found = await ui.find({ type: 'Text', text: pattern })
    await ui.unmount()
    return found?.text
  }

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: PLAN_PATH, content: plan })
  await $.tool.call({ tool: 'Bash', command: 'git switch -c feature/probe' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/a.mjs`, content: 'x' })
  // A full test run mid-build, or a narrow check, is not the gate.
  await $.tool.call({ tool: 'Bash', command: 'cd C:/repo && node --test' })
  await $.tool.call({ tool: 'Bash', command: 'node --test test/a.test.mjs' })
  expect(await text(/^Task 1 of 3/)).toBe('Task 1 of 3: building')

  ledger = '## Task 1 A\n## Task 2 B\n## Task 3 C\n'
  await $.tool.call({ tool: 'Edit', file_path: LEDGER_PATH, old_string: '', new_string: ledger })
  await $.tool.call({ tool: 'Bash', command: 'cd C:/repo && node --test' })
  expect(await text(/Release gate passed/)).toBe('Release gate passed')

  await $.tool.call({ tool: 'Agent', subagent_type: 'shipright:final-reviewer', prompt: 'p', description: 'd' })
  // Merging something else does not end the run; merging the feature branch does.
  await $.tool.call({ tool: 'Bash', command: 'git merge origin/main' })
  expect(await text(/Final review/)).toBe('Final review of the whole branch')
  await $.tool.call({ tool: 'Bash', command: 'git switch main && git merge --no-ff feature/probe -m "Merge"' })
  expect(await text(/Merged locally/)).toBe('Merged locally')
  expect(await text(/%$/)).toMatch(/100%$/)
})

test('the pane follows a run from plan to pull request without the session telling it', async ($, on) => {
  let now = 1_000
  let ledger = ''
  on('clock.now', () => ({ value: now }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => {
    const path = e.path.replace(/\\/g, '/')
    if (path === PLAN_PATH) return { value: PLAN }
    if (path === LEDGER_PATH) return { value: ledger }
    throw new Error('ENOENT')
  })
  on('command.register', () => ({ value: { command: 'shipright-progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  const text = async (surface: 'terminal' | 'desktop' | 'vscode' | 'mobile', pattern: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface })
    const found = await ui.find({ type: 'Text', text: pattern })
    await ui.unmount()
    return found?.text
  }

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  expect(await text('desktop', /No shipright run/)).toBe('No shipright run in this session yet.')

  await $.tool.call({ tool: 'Write', file_path: PLAN_PATH, content: PLAN })
  expect(await text('desktop', /Plan ready/)).toBe('Plan ready, 3 tasks')

  // Checking the gate script while planning is not the gate; the pane stays on the plan.
  await $.tool.call({ tool: 'Bash', command: 'grep check:release package.json' })
  expect(await text('desktop', /Plan ready/)).toBe('Plan ready, 3 tasks')
  // Nor is a note written outside the repo the build starting.
  await $.tool.call({ tool: 'Write', file_path: 'C:/Users/me/notes.md', content: 'x' })
  expect(await text('desktop', /Plan ready/)).toBe('Plan ready, 3 tasks')
  expect(await text('desktop', /Release gate/)).toBe('○ Release gate')

  await $.tool.call({ tool: 'Bash', command: 'git switch -c feature/probe' })
  now = 2_000
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/agent/caps.mjs`, content: 'x' })
  expect(await text('terminal', /^Task 1 of 3/)).toBe('Task 1 of 3: building')

  await $.tool.call({ tool: 'Agent', subagent_type: 'shipright:task-reviewer', prompt: 'p', description: 'd' })
  ledger = '## Task 1 Agent capabilities - abc123\n'
  now = 62_000
  await $.tool.call({ tool: 'Edit', file_path: LEDGER_PATH, old_string: '', new_string: ledger })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    expect(await text(surface, /^Tasks /)).toBe('Tasks 1/3')
    expect(await text(surface, /^Task 2 of 3/)).toBe('Task 2 of 3: building')
    expect(await text(surface, /2\. Metrics/)).toBe('▶ 2. Metrics collector')
  }
  expect(await text('desktop', /elapsed/)).toBe('1 min elapsed, about 2 min of building left')

  ledger += '## Task 2 Metrics - def\n## Task 3 Docker - fed\n'
  await $.tool.call({ tool: 'Bash', command: 'git add .shipright/ledger.md && git commit -m x' })
  await $.tool.call({ tool: 'Bash', command: 'npm run check:release' })
  expect(await text('desktop', /Release gate passed/)).toBe('Release gate passed')

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  expect(await text('desktop', /%$/)).toMatch(/100%$/)
  expect(await text('desktop', /Pull request opened/)).toBe('Pull request opened')
})
