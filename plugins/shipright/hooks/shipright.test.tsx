import { expect, test } from 'claude-code/testing'

import { classify, emptyProgress, etaMs, mergeTasks, parseLedger, parsePlan, percent } from './progress'

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
    tasks: [
      { n: 1, title: 'Agent capabilities' },
      { n: 2, title: 'Metrics collector' },
      { n: 3, title: 'Docker client' },
    ],
  })
  expect(parsePlan('# Old Implementation Plan\n### Task 7: Thing\n').tasks).toEqual([{ n: 7, title: 'Thing' }])
  expect([...parseLedger('## Task 1 caps - abc123\nProduced: x\n## Task 3 docker - def\n')]).toEqual([1, 3])
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
  expect(classify({ tool: 'Agent', subagent_type: 'shipright:task-reviewer' })).toEqual({ kind: 'taskReview' })
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
  expect(await text('desktop', /Plan ready/)).toBe('Plan ready, 3 tasks, waiting for your review')

  // Checking the gate script while planning is not the gate; the pane stays on the plan.
  await $.tool.call({ tool: 'Bash', command: 'grep check:release package.json' })
  expect(await text('desktop', /Plan ready/)).toBe('Plan ready, 3 tasks, waiting for your review')
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
