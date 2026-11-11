import { expect, test } from 'claude-code/testing'

import { DEFAULTS } from './config'
import { emptyLedger, mergeLedger } from './ledger'
import { briefPaths, checkPlan, fill, parsePlan, renderBrief, riskyMatches, rulesGroup, section } from './plan'
import { PLAN_FORMAT, TEMPLATES } from './templates'

const PLAN = `# p12: CSV export

## Constraints
Kysely only. Every query filters by organization.

## Parked
The XLSX format.

### Task 1: Export job schema
- Files: \`apps/web/migrations/0042_export.sql\`, apps/web/src/server/export/job.server.ts
- Pinned: \`createExportJob(db, organizationId, input): Promise<ExportJob>\`
- Needs: none
- Check: npm test -w @catalo/web -- export
- Commit: feat(export): job schema
- Focus: the organization filter on every read

Write the failing test for createExportJob first.

### Task 2: Export route
- **Files:** apps/web/src/routes/export.tsx, apps/web/src/server/export/job.server.ts
- Needs: 1
- Focus: the auth middleware

Build the route.
`

const RULES = `# Rules

## Before dispatch

1. Check the plan against the spec. (CLAUDE.md)

## In every implementer brief

2. No raw SQL in TypeScript. (CLAUDE.md)
3. Both message files. (CLAUDE.md)

## In every reviewer brief

## Before the PR

4. Run the renderer image suite when the renderer changed. (CLAUDE.md)
`

const SPEC = `# p12: CSV export

## What
An export.

## Acceptance

- [ ] An admin downloads a CSV of the catalog.
- [ ] Another organization's rows never appear.

## Out of scope
XLSX.
`

test('parsePlan reads the title, the sections and each task with its fields, bold or plain', () => {
  const plan = parsePlan(PLAN)
  expect(plan.title).toBe('p12: CSV export')
  expect(plan.constraints).toBe('Kysely only. Every query filters by organization.')
  expect(plan.parked).toBe('The XLSX format.')
  expect(plan.tasks.map(t => [t.n, t.title])).toEqual([[1, 'Export job schema'], [2, 'Export route']])
  expect(plan.tasks[0]).toMatchObject({ files: ['apps/web/migrations/0042_export.sql', 'apps/web/src/server/export/job.server.ts'], needs: [], check: 'npm test -w @catalo/web -- export', commit: 'feat(export): job schema', focus: 'the organization filter on every read' })
  expect(plan.tasks[0]!.pinned).toContain('createExportJob')
  expect(plan.tasks[0]!.body).toContain('Write the failing test')
  expect(plan.tasks[0]!.body).not.toContain('Task 2')
  expect(plan.tasks[1]).toMatchObject({ files: ['apps/web/src/routes/export.tsx', 'apps/web/src/server/export/job.server.ts'], needs: [1], check: '' })
  expect(checkPlan(plan)).toEqual([])
})

test('the plan format the tool answers parses into one task', () => {
  const plan = parsePlan(PLAN_FORMAT)
  expect(plan.tasks.length).toBe(1)
  expect(plan.tasks[0]!.files.length).toBeGreaterThan(0)
})

test('checkPlan names what stops a build', () => {
  expect(checkPlan(parsePlan('# x\n\nprose'))).toEqual(['no `### Task N: <title>` heading'])
  const bad = parsePlan('### Task 1: A\n- Files: a.ts\n- Needs: 2\n\n### Task 3: B\n\n### Task 3:\n- Files: b.ts')
  expect(checkPlan(bad)).toEqual(['task 1 needs task 2, which is not an earlier task', 'task 3 is at position 2: number the tasks 1 to 3 in order', 'task 3 has no `- Files:` line', 'task 3 has no title'])
})

test('section, rulesGroup and riskyMatches', () => {
  expect(section(SPEC, 'Acceptance')).toBe("- [ ] An admin downloads a CSV of the catalog.\n- [ ] Another organization's rows never appear.")
  expect(section(SPEC, 'Open')).toBe('')
  expect(rulesGroup(RULES, 'In every implementer brief')).toBe('2. No raw SQL in TypeScript. (CLAUDE.md)\n3. Both message files. (CLAUDE.md)')
  expect(rulesGroup(RULES, 'In every reviewer brief')).toBe('none')
  expect(riskyMatches(['apps/web/migrations/0042_export.sql', 'README.md'], ['apps/web/migrations/**', 'packages/**'])).toEqual(['apps/web/migrations/0042_export.sql'])
})

test('briefPaths keeps the names of the ledger folder', () => {
  expect(briefPaths('p12', 'implementer', 2, 1).brief).toBe('docs/pipeline/ledgers/p12/task-2-brief.md')
  expect(briefPaths('p12', 'fix', 2, 3).report).toBe('docs/pipeline/ledgers/p12/task-2-fix-3-report.md')
  expect(briefPaths('p12', 'review', 2, 1).brief).toBe('docs/pipeline/ledgers/p12/task-2-review-brief.md')
  expect(briefPaths('p12', 'review', 2, 2).brief).toBe('docs/pipeline/ledgers/p12/task-2-review-2-brief.md')
  expect(briefPaths('p12', 'final', 2, 1).brief).toBe('docs/pipeline/ledgers/p12/final-brief.md')
  expect(briefPaths('p12', 'final', 2, 2).report).toBe('docs/pipeline/ledgers/p12/final-review-2-report.md')
})

test('fill names a placeholder it has no value for', () => {
  expect(fill('a {{x}} b {{y}} {{y}}', { x: '1' })).toEqual({ text: 'a 1 b  ', missing: ['y'] })
})

const base = () => ({ item: 'p12', itemTitle: 'CSV export', round: 1, plan: parsePlan(PLAN), config: { ...DEFAULTS, checks: { fast: 'npm run check:fast', task: 'npm test', gate: 'npm run gate' } }, ledger: emptyLedger('p12'), rulesMd: RULES, specMd: SPEC })

test('every built-in template fills with no placeholder left', () => {
  const ledger = mergeLedger(emptyLedger('p12'), { base: 'a1b2c3d', rulings: [{ task: 1, text: 'Keep the snapshot id', why: 'immutable', costIfWrong: 'x' }] }, 'now')
  const made = [
    renderBrief({ ...base(), kind: 'implementer', task: 1, attribution: 'Co-Authored-By: X' }),
    renderBrief({ ...base(), kind: 'fix', task: 1, round: 2, findings: '- job.server.ts:14 · no organization filter' }),
    renderBrief({ ...base(), kind: 'review', task: 1, commits: 'a1..b2', risky: ['apps/web/migrations/0042_export.sql'] }),
    renderBrief({ ...base(), kind: 'final', task: 2, ledger, head: 'f00d' }),
  ]
  for (const b of made) expect(b.text).not.toMatch(/\{\{|\}\}/)
  expect(Object.keys(TEMPLATES)).toEqual(['implementer', 'fix', 'review', 'final'])
})

test('an implementer brief carries the task, the boundaries, the task check, the rules and the role models', () => {
  const b = renderBrief({ ...base(), kind: 'implementer', task: 1, carried: 'minor: log wording', attribution: 'Co-Authored-By: X' })
  expect(b).toMatchObject({ brief: 'docs/pipeline/ledgers/p12/task-1-brief.md', report: 'docs/pipeline/ledgers/p12/task-1-report.md', model: 'sonnet', effort: 'medium', role: 'implementer' })
  expect(b.text).toContain('# p12 · task 1 of 2: Export job schema')
  expect(b.text).toContain('Write the failing test for createExportJob first.')
  expect(b.text).toContain('- You own: apps/web/migrations/0042_export.sql, apps/web/src/server/export/job.server.ts')
  // A file both tasks own is not forbidden to the first.
  expect(b.text).toContain('- Not yours: apps/web/src/routes/export.tsx\n')
  expect(b.text).toContain('`npm test -w @catalo/web -- export` once')
  expect(b.text).toContain('message `feat(export): job schema`')
  expect(b.text).toContain('2. No raw SQL in TypeScript.')
  expect(b.text).toContain('minor: log wording')
  expect(b.text.trimEnd().endsWith('Co-Authored-By: X')).toBe(true)
  // The second task has no Check or Commit line: the config's check and a message from the title.
  const second = renderBrief({ ...base(), kind: 'implementer', task: 2 })
  expect(second.text).toContain('`npm test` once')
  expect(second.text).toContain('message `p12: Export route`')
  expect(second.text).toContain('(no attribution lines)')
})

test('escalate picks the escalate model; the ledger keeps the attribution', () => {
  const ledger = { ...emptyLedger('p12'), attribution: 'Co-Authored-By: Kept' }
  const b = renderBrief({ ...base(), ledger, kind: 'fix', task: 1, findings: 'x', isEscalated: true })
  expect(b).toMatchObject({ model: 'opus', effort: 'high', role: 'escalate', brief: 'docs/pipeline/ledgers/p12/task-1-fix-1-brief.md' })
  expect(b.text).toContain('fix round 1 of 3')
  expect(b.text).toContain('Co-Authored-By: Kept')
})

test('a review brief names the range, the risky match and the implementer files; a final brief the acceptance list and the rulings', () => {
  const r = renderBrief({ ...base(), kind: 'review', task: 1, commits: 'a1..b2', risky: ['apps/web/migrations/0042_export.sql'] })
  expect(r).toMatchObject({ model: 'opus', role: 'reviewer' })
  expect(r.text).toContain('`git diff a1..b2`')
  expect(r.text).toContain('Risky paths this diff touches: apps/web/migrations/0042_export.sql')
  expect(r.text).toContain('docs/pipeline/ledgers/p12/task-1-report.md')
  expect(r.text).toContain('the organization filter on every read')
  const ledger = mergeLedger(emptyLedger('p12'), { base: 'a1b2c3d', rulings: [{ task: 1, text: 'Keep the snapshot id', why: 'immutable', costIfWrong: 'x' }] }, 'now')
  const f = renderBrief({ ...base(), kind: 'final', task: 2, ledger, head: 'f00d' })
  expect(f).toMatchObject({ model: 'opus', effort: 'xhigh', role: 'final', brief: 'docs/pipeline/ledgers/p12/final-brief.md' })
  expect(f.text).toContain('`git diff a1b2c3d..f00d`')
  expect(f.text).toContain("- [ ] Another organization's rows never appear.")
  expect(f.text).toContain('1. Keep the snapshot id — immutable')
  expect(f.text).toContain('Parked on purpose: The XLSX format.')
  expect(f.text).toContain('`npm run gate`')
  expect(f.text).toContain('4. Run the renderer image suite')
})

test('renderBrief refuses what it cannot fill', () => {
  expect(() => renderBrief({ ...base(), kind: 'implementer', task: 9 })).toThrow('the plan has no task 9')
  expect(() => renderBrief({ ...base(), kind: 'fix', task: 1 })).toThrow('a fix brief needs findings')
  expect(() => renderBrief({ ...base(), kind: 'review', task: 1 })).toThrow('a review brief needs commits')
  expect(() => renderBrief({ ...base(), kind: 'final', task: 2, specMd: '# x' })).toThrow('has no Acceptance list')
  expect(() => renderBrief({ ...base(), kind: 'implementer', task: 1, template: 'x {{nope}}' })).toThrow('{{nope}}')
})

test('briefPaths takes the folder; a brief rendered with places names those paths and not docs/pipeline', () => {
  expect(briefPaths('12', 'implementer', 2, 1, '.pipeline/12')).toEqual({ brief: '.pipeline/12/task-2-brief.md', report: '.pipeline/12/task-2-report.md' })
  expect(briefPaths('p1', 'final', 1, 1)).toEqual({ brief: 'docs/pipeline/ledgers/p1/final-brief.md', report: 'docs/pipeline/ledgers/p1/final-report.md' })
  const out = renderBrief({ ...base(), kind: 'implementer', task: 1, item: '12', places: { specRel: '.pipeline/12/spec.md', planRel: '.pipeline/12/plan.md', recordsDir: '.pipeline', briefDir: '.pipeline/12' } })
  expect(out.brief).toBe('.pipeline/12/task-1-brief.md')
  expect(out.text).toContain('.pipeline/12/plan.md')
  expect(out.text).not.toContain('docs/pipeline')
})
