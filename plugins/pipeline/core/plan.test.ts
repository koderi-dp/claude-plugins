import { expect, test } from 'claude-code/testing'

import { DEFAULTS } from './config'
import { emptyLedger, mergeLedger } from './ledger'
import { acceptanceItems, briefPaths, checkCoverage, checkPlan, commitArgs, fill, parsePlan, principlesOf, renderBrief, riskyMatches, rulesGroup, section, splitAttribution } from './plan'
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
- Check: npm test -w @larder/web -- export
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
  expect(plan.tasks[0]).toMatchObject({ files: ['apps/web/migrations/0042_export.sql', 'apps/web/src/server/export/job.server.ts'], needs: [], check: 'npm test -w @larder/web -- export', commit: 'feat(export): job schema', focus: 'the organization filter on every read' })
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
  expect(b.text).toContain('`npm test -w @larder/web -- export` once')
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
  // A request with no Acceptance list is reviewed against its whole text.
  expect(renderBrief({ ...base(), kind: 'final', task: 2, specMd: '# Export\n\nCSV, please' }).text).toContain('judge the branch against the whole of it.)\n\n# Export\n\nCSV, please')
  expect(() => renderBrief({ ...base(), kind: 'implementer', task: 1, template: 'x {{nope}}' })).toThrow('{{nope}}')
})

test('briefPaths takes the folder; a brief rendered with places names those paths and not docs/pipeline', () => {
  expect(briefPaths('12', 'implementer', 2, 1, '.pipeline/12')).toEqual({ brief: '.pipeline/12/task-2-brief.md', report: '.pipeline/12/task-2-report.md' })
  expect(briefPaths('p1', 'final', 1, 1)).toEqual({ brief: 'docs/pipeline/ledgers/p1/final-brief.md', report: 'docs/pipeline/ledgers/p1/final-report.md' })
  const out = renderBrief({ ...base(), principlesMd: '- Keep it small.', kind: 'implementer', task: 1, item: '12', places: { specRel: '.pipeline/12/spec.md', planRel: '.pipeline/12/plan.md', recordsDir: '.pipeline', briefDir: '.pipeline/12' } })
  expect(out.brief).toBe('.pipeline/12/task-1-brief.md')
  expect(out.text).toContain('.pipeline/12/plan.md')
  expect(out.text).not.toContain('docs/pipeline')
})

// ---------- attribution: trailers to commits, the rest to the pull request ----------

const GIVEN = 'Co-Authored-By: Claude X <noreply@anthropic.com>\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'

test('attribution lines are split: git trailers for commits, every other line for the pull request', () => {
  expect(splitAttribution(GIVEN)).toEqual({ trailers: ['Co-Authored-By: Claude X <noreply@anthropic.com>'], rest: ['🤖 Generated with [Claude Code](https://claude.com/claude-code)'] })
  expect(splitAttribution('')).toEqual({ trailers: [], rest: [] })
})

test('a commit message ends with the trailers once, and the pull request line stays out of it', () => {
  expect(commitArgs('Add shout', GIVEN)).toEqual(['-m', 'Add shout', '-m', 'Co-Authored-By: Claude X <noreply@anthropic.com>'])
  // The lead already ended its message with the lines it was given: nothing is written twice.
  expect(commitArgs(`Add shout\n\n${GIVEN}`, GIVEN)).toEqual(['-m', 'Add shout\n\nCo-Authored-By: Claude X <noreply@anthropic.com>'])
  expect(commitArgs('Add shout\n\nco-authored-by: Claude X <noreply@anthropic.com>', GIVEN)).toEqual(['-m', 'Add shout\n\nco-authored-by: Claude X <noreply@anthropic.com>'])
  expect(commitArgs('Add shout', '')).toEqual(['-m', 'Add shout'])
})

test('a brief that commits names only the trailers', () => {
  const b = renderBrief({ ...base(), kind: 'implementer', task: 1, attribution: GIVEN })
  expect(b.text).toContain('Co-Authored-By: Claude X <noreply@anthropic.com>')
  expect(b.text).not.toContain('Generated with')
})

test('a review brief names the worktree and does not tell a read-only reviewer to edit files', () => {
  const root = '/p/main/.claude/worktrees/p12'
  for (const b of [renderBrief({ ...base(), kind: 'review', task: 1, commits: 'a1..b2', root }), renderBrief({ ...base(), kind: 'final', task: 2, head: 'f00d', root })]) {
    expect(b.text).toContain(`The item's worktree is \`${root}\``)
    expect(b.text).toContain('Read-only')
    expect(b.text).not.toContain('edit files by their path')
  }
  expect(renderBrief({ ...base(), kind: 'implementer', task: 1, root }).text).toContain('edit files by their path under it')
})

test('attribution given as a sentence about the lines never reaches a commit as it stands', () => {
  // What a lead sent in an end-to-end run: one line of prose that quotes both lines.
  const PROSE = 'Commits: end with "Co-Authored-By: Claude X <noreply@anthropic.com>". Pull requests: end with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".'
  expect(splitAttribution(PROSE)).toEqual({ trailers: ['Co-Authored-By: Claude X <noreply@anthropic.com>'], rest: [] })
  expect(commitArgs('Add shout', PROSE)).toEqual(['-m', 'Add shout', '-m', 'Co-Authored-By: Claude X <noreply@anthropic.com>'])
  // A label with a colon is not a git trailer: a trailer's key has a hyphen (Co-Authored-By, Signed-off-by).
  expect(splitAttribution('Note: built by hand').trailers).toEqual([])
  expect(splitAttribution('Signed-off-by: A B <a@b.c>').trailers).toEqual(['Signed-off-by: A B <a@b.c>'])
})

// ---------- 0.9.0: acceptance coverage and project principles ----------

const COVERED = PLAN.replace('- Needs: none\n', '- Needs: none\n- Covers: 1\n').replace('- Needs: 1\n', '- Needs: 1\n- **Covers:** 1, 2\n')

test('0.9.0: acceptanceItems numbers the lines of the Acceptance section, with a wrapped line joined to its item', () => {
  expect(acceptanceItems(SPEC)).toEqual(['An admin downloads a CSV of the catalog.', "Another organization's rows never appear."])
  expect(acceptanceItems('## Acceptance\n\n1. First,\n   on two lines.\n- [x] Second.\n* Third\n\nA closing sentence.\n\n## Open\n- not one')).toEqual(['First, on two lines.', 'Second.', 'Third'])
  expect(acceptanceItems('## What\n\nNo list here.')).toEqual([])
})

test('0.9.0: a task names the acceptance items it delivers on a Covers line', () => {
  expect(parsePlan(COVERED).tasks.map(t => t.covers)).toEqual([[1], [1, 2]])
  expect(parsePlan(PLAN).tasks.map(t => t.covers)).toEqual([[], []])
})

test('0.9.0: checkCoverage names each acceptance item no task covers, unless the plan parks it, and a number the spec does not have', () => {
  const items = acceptanceItems(SPEC)
  expect(checkCoverage(parsePlan(COVERED), items)).toEqual([])
  // No Covers line at all: every item is uncovered.
  expect(checkCoverage(parsePlan(PLAN), items)).toEqual([
    'acceptance 1 is covered by no task: "An admin downloads a CSV of the catalog."',
    'acceptance 2 is covered by no task: "Another organization\'s rows never appear."',
  ])
  // An item the plan leaves out on purpose is named under Parked.
  const parked = PLAN.replace('The XLSX format.', 'The XLSX format. Acceptance 2: waits for the tenant work.').replace('- Needs: none\n', '- Needs: none\n- Covers: 1\n')
  expect(checkCoverage(parsePlan(parked), items)).toEqual([])
  expect(checkCoverage(parsePlan(COVERED.replace('- Covers: 1\n', '- Covers: 1, 5\n')), items)).toEqual(['task 1 covers acceptance 5, and the spec has 2'])
  // A spec with no acceptance list has nothing to cover.
  expect(checkCoverage(parsePlan(PLAN), [])).toEqual([])
  // A long item is cut in the message.
  expect(checkCoverage(parsePlan(PLAN), ['x'.repeat(200)])[0]!.length).toBeLessThan(140)
})

test('0.9.0: the implementer and the reviewer read the acceptance items their task delivers; the final review reads which task claims each', () => {
  const plan = parsePlan(COVERED)
  const impl = renderBrief({ ...base(), plan, kind: 'implementer', task: 2 }).text
  expect(impl).toContain("## Delivers\n\nThe acceptance items of the spec this task must make true:\n1. An admin downloads a CSV of the catalog.\n2. Another organization's rows never appear.\n")
  const review = renderBrief({ ...base(), plan, kind: 'review', task: 1, commits: 'a1..b2' }).text
  expect(review).toContain('- Acceptance items this task claims to deliver; hold the diff to each:\n1. An admin downloads a CSV of the catalog.\n')
  expect(review).not.toContain("2. Another organization's rows")
  const final = renderBrief({ ...base(), plan, kind: 'final', task: 2 }).text
  expect(final).toContain('Which task claims each line: 1 → tasks 1, 2 · 2 → task 2')
  // A plan written before Covers lines says so, and nothing is invented.
  expect(renderBrief({ ...base(), kind: 'implementer', task: 1 }).text).toContain('must make true:\nnone named in the plan\n')
  expect(renderBrief({ ...base(), kind: 'final', task: 2 }).text).toContain('Which task claims each line: the plan names none')
  expect(renderBrief({ ...base(), plan: parsePlan(COVERED.replace('The XLSX format.', 'Acceptance 2, for now.').replace('- **Covers:** 1, 2\n', '')), kind: 'final', task: 2 }).text).toContain('Which task claims each line: 1 → task 1 · 2 → parked')
})

const PRINCIPLES = `# Principles

How this project wants its code.

<!-- Examples:
- An example that is not a principle.
-->

- No new dependency without asking.
1. Every calculation with money has a test.
`

test('0.9.0: principlesOf keeps the list lines, drops comments and prose, and cuts a long list with a pointer to the file', () => {
  expect(principlesOf(PRINCIPLES)).toBe('- No new dependency without asking.\n1. Every calculation with money has a test.')
  expect(principlesOf('')).toBe('none written (docs/pipeline/principles.md)')
  expect(principlesOf('# Principles\n\n<!--\n- only an example\n-->\n')).toBe('none written (docs/pipeline/principles.md)')
  const long = Array.from({ length: 20 }, (_, i) => `- Principle ${i + 1}.`).join('\n')
  const cut = principlesOf(long).split('\n')
  expect(cut).toHaveLength(16)
  expect(cut[14]).toBe('- Principle 15.')
  expect(cut[15]).toBe('… and 5 more in docs/pipeline/principles.md')
})

test('0.9.0: the implementer, the reviewer and the final reviewer read the principles; a fix round does not', () => {
  const withP = { ...base(), principlesMd: PRINCIPLES }
  const list = '- No new dependency without asking.\n1. Every calculation with money has a test.'
  expect(renderBrief({ ...withP, kind: 'implementer', task: 1 }).text).toContain(`## Project principles\n\nHow this project wants its code; keep to each:\n${list}\n`)
  expect(renderBrief({ ...withP, kind: 'review', task: 1, commits: 'a1..b2' }).text).toContain(`## Project principles\n\nA finding that breaks one names it:\n${list}\n`)
  expect(renderBrief({ ...withP, kind: 'final', task: 2 }).text).toContain(`## Project principles\n\nA finding that breaks one names it:\n${list}\n`)
  expect(renderBrief({ ...withP, kind: 'fix', task: 1, findings: '- x' }).text).not.toContain('Project principles')
  expect(renderBrief({ ...base(), kind: 'implementer', task: 1 }).text).toContain('keep to each:\nnone written (docs/pipeline/principles.md)\n')
})

test('0.9.0: the plan format names the Covers line', () => {
  expect(PLAN_FORMAT).toContain('- Covers: <the numbers of the acceptance items of the spec this task delivers, counted from 1>')
})
