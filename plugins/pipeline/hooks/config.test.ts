import { expect, test } from 'claude-code/testing'

import { DEFAULTS, draftConfig, normalizeConfig } from './config'

test('DEFAULTS carries every key of the config', () => {
  expect(DEFAULTS.version).toBe(1)
  expect(DEFAULTS.mainBranch).toBe('main')
  expect(DEFAULTS.branch).toBe('feat/<id>')
  expect(DEFAULTS.merge).toBe('pr')
  expect(DEFAULTS.limits).toEqual({ fixRounds: 3, silentMinutes: 10, taskMinutes: 45, itemTokens: 4000000, parallel: 1 })
  expect(DEFAULTS.runner).toBe('subagent')
  expect(Object.keys(DEFAULTS.models).sort()).toEqual(['escalate', 'final', 'implementer', 'reviewer'])
  expect(DEFAULTS.notify).toBe('milestones')
  expect(DEFAULTS.stop.length).toBeGreaterThan(0)
})

test('normalizeConfig fills missing keys from the defaults without problems', () => {
  const { config, problems } = normalizeConfig({ version: 1, mainBranch: 'develop' })
  expect(problems).toEqual([])
  expect(config.mainBranch).toBe('develop')
  expect(config.branch).toBe(DEFAULTS.branch)
  expect(config.limits).toEqual(DEFAULTS.limits)
  expect(config.models.reviewer).toEqual(DEFAULTS.models.reviewer)
  expect(config.stop).toEqual(DEFAULTS.stop)
})

test('normalizeConfig: runner is subagent or session, limits.parallel a number', () => {
  expect(normalizeConfig({ runner: 'session', limits: { parallel: 3 } })).toMatchObject({ config: { runner: 'session', limits: { ...DEFAULTS.limits, parallel: 3 } }, problems: [] })
  const { config, problems } = normalizeConfig({ runner: 'thread', limits: { parallel: 'two' } })
  expect(problems).toEqual(['limits.parallel: expected a number, got string', 'runner: expected "subagent" or "session", got "thread"'])
  expect(config.runner).toBe('subagent')
  expect(config.limits.parallel).toBe(1)
})

test('normalizeConfig names a wrong merge value and falls back to the default', () => {
  const { config, problems } = normalizeConfig({ merge: 'sometimes' })
  expect(problems).toEqual(['merge: expected "auto" or "pr", got "sometimes"'])
  expect(config.merge).toBe('pr')
})

test('normalizeConfig names wrong types and keeps the rest', () => {
  const { config, problems } = normalizeConfig({
    mainBranch: 7,
    riskyPaths: 'apps/**',
    limits: { fixRounds: 'three', silentMinutes: 5 },
    checks: { fast: 'npm run check:fast', gate: 3 },
    models: { reviewer: { model: 'opus', effort: 'extreme' } },
    notify: 'loud',
    extra: true,
  })
  expect(problems).toContain('mainBranch: expected a string, got number')
  expect(problems).toContain('riskyPaths: expected an array of strings, got string')
  expect(problems).toContain('limits.fixRounds: expected a number, got string')
  expect(problems).toContain('checks.gate: expected a string, got number')
  expect(problems).toContain('models.reviewer.effort: expected one of low, medium, high, xhigh, max, default, got "extreme"')
  expect(problems).toContain('notify: expected "off", "milestones" or "all", got "loud"')
  expect(config.mainBranch).toBe('main')
  expect(config.riskyPaths).toEqual([])
  expect(config.limits).toEqual({ ...DEFAULTS.limits, silentMinutes: 5 })
  expect(config.checks).toEqual({ fast: 'npm run check:fast' })
  expect(config.models.reviewer).toEqual({ model: 'opus', effort: DEFAULTS.models.reviewer.effort })
  expect(config.notify).toBe('milestones')
  expect(config.extra).toBe(true)
})

test('normalizeConfig on something that is not an object answers the defaults and one problem', () => {
  const { config, problems } = normalizeConfig([1, 2])
  expect(config).toEqual(DEFAULTS)
  expect(problems).toEqual(['config: expected an object, got array'])
  expect(normalizeConfig(null).problems).toEqual(['config: expected an object, got null'])
})

const CATALO = {
  scripts: {
    build: 'turbo run build',
    typecheck: 'turbo run typecheck',
    test: 'turbo run test',
    lint: 'turbo run lint',
    'check:fast': 'node scripts/check-fast.mjs',
  },
  makeTargets: [],
  ci: 'name: ci\non: [push]\njobs:\n  check:\n    steps:\n      - run: npm run build\n      - run: npm run test\n',
  dirs: ['apps', 'packages', 'docs', 'tooling'],
  prose: [
    'The auth code under apps/web/src/server/auth is risky: every change gets an independent review.',
    'Migrations in apps/web/migrations need a reviewer who probes.',
    'Pricing in packages/domain/src/pricing handles money; treat it as risky.',
    'An implementer gets at most three fix rounds before escalation.',
    'Ask the user only for product decisions the spec leaves open; security trade-offs; new cost.',
  ],
}

test('draftConfig maps catalo-like scripts and prose to the three tiers, risky paths and stop', () => {
  const { config, sources } = draftConfig(CATALO)
  expect(config.checks.fast).toBe('npm run check:fast')
  expect(config.checks.task).toBe('npm run test')
  expect(config.checks.gate).toBe('npm run build && npm run typecheck && npm run test && npm run lint')
  expect(config.riskyPaths).toEqual(['apps/web/src/server/auth/**', 'apps/web/migrations/**', 'packages/domain/src/pricing/**'])
  expect(config.limits.fixRounds).toBe(3)
  expect(config.merge).toBe('pr')
  expect(config.stop).toEqual(['product decisions the spec leaves open', 'security trade-offs', 'new cost'])
  expect(sources['checks.fast']).toBe('package script check:fast')
  expect(sources['checks.task']).toBe('package script test')
  expect(sources['checks.gate']).toBe('package scripts build, typecheck, test, lint')
  expect(sources['riskyPaths']).toContain('prose')
  expect(sources['stop']).toContain('prose')
  expect(sources['limits.fixRounds']).toContain('prose')
  expect(sources['merge']).toBe('default')
  expect(sources['mainBranch']).toBe('default')
})

const OPENHUDDLE = {
  scripts: {},
  makeTargets: ['build', 'test', 'check', 'gen-check', 'lint'],
  ci: 'jobs:\n  check:\n    steps:\n      - run: make check\n',
  dirs: ['cmd', 'internal', 'docs'],
  prose: [
    'Sonnet implements, Opus reviews.',
    'Merges are auto-merge on green CI.',
    'The session store (internal/session) and the parser (internal/wire/parser) are concurrency-sensitive.',
    'Stop and ask when CI cannot be made green, or when credentials are needed.',
  ],
}

test('draftConfig maps openhuddle-like make targets, auto-merge and the stop list', () => {
  const { config, sources } = draftConfig(OPENHUDDLE)
  expect(config.checks.fast).toBeUndefined()
  expect(config.checks.task).toBe('make test')
  expect(config.checks.gate).toBe('make check')
  expect(config.merge).toBe('auto')
  expect(config.riskyPaths).toEqual(['internal/session/**', 'internal/wire/parser/**'])
  expect(config.stop).toEqual(['CI cannot be made green', 'credentials are needed'])
  expect(sources['checks.gate']).toBe('make target check')
  expect(sources['checks.task']).toBe('make target test')
  expect(sources['merge']).toContain('prose')
  expect(sources['checks.fast']).toBe('none found; fill in')
})

test('draftConfig with nothing found answers the defaults with every source named', () => {
  const { config, sources } = draftConfig({ scripts: {}, makeTargets: [], ci: '', dirs: [], prose: [] })
  expect(config.checks).toEqual({})
  expect(config.riskyPaths).toEqual([])
  expect(config.stop).toEqual(DEFAULTS.stop)
  expect(sources['riskyPaths']).toBe('none found; fill in')
  expect(sources['checks.task']).toBe('none found; fill in')
  for (const key of ['mainBranch', 'branch', 'models', 'limits.fixRounds', 'limits.silentMinutes', 'merge', 'stop', 'notify', 'afterMerge', 'protectedPaths']) {
    expect(sources[key]).toBe('default')
  }
})

test('draftConfig prefers a script named check over the combination and reads a sentence after "ask only when"', () => {
  const { config, sources } = draftConfig({
    scripts: { build: 'b', test: 't', check: 'npm run build && npm run test', 'test:unit': 'vitest' },
    makeTargets: [],
    ci: '',
    dirs: [],
    prose: ['Ask only when a destructive data change is needed.'],
  })
  expect(config.checks.gate).toBe('npm run check')
  expect(config.checks.task).toBe('npm run test')
  expect(sources['checks.gate']).toBe('package script check')
  expect(config.stop).toEqual(['a destructive data change is needed'])
})

// The catalo dry run (docs/superpowers/specs/2026-11-05-pipeline-dry-run.md): one test per mismatch.

test('mismatch 7: riskyPaths keeps only tokens whose first segment is a top-level directory, with a file segment dropped', () => {
  const { config, sources } = draftConfig({
    scripts: {},
    makeTargets: [],
    ci: '',
    dirs: ['apps', 'packages', 'docs'],
    prose: [
      'Draft autosave, undo/redo, and single-editor page locks/heartbeats on branch claude/sale-pricing-415cba; formats A3/A4/A5/custom at €/m².',
      'Use Kysely for every query. SQL belongs in `apps/web/migrations/*.sql`; the auth tables live in apps/web/src/server/auth/ and pricing in packages/domain/src/pricing.',
      'Migration/runtime notes and the token/class-only rule are in docs/ops/migrations.md.',
    ],
  })
  expect(config.riskyPaths).toEqual(['apps/web/migrations/**', 'apps/web/src/server/auth/**', 'packages/domain/src/pricing/**'])
  expect(sources['riskyPaths']).toBe('prose naming risky code (3 directories)')
  expect(draftConfig({ scripts: {}, makeTargets: [], ci: '', dirs: [], prose: ['The auth code under apps/web/src/server/auth is risky.'] }).config.riskyPaths).toEqual([])
})

test('mismatch 8: "after two failed reviews" sets fixRounds', () => {
  const { config, sources } = draftConfig({
    scripts: {},
    makeTargets: [],
    ci: '',
    dirs: [],
    prose: [
      'For token/class-only visual changes, one review per increment is enough; do not re-run full screenshot sets for each fix round.',
      'Escalation: after two failed reviews or a blocked task, switch coder models or increase reasoning capability.',
    ],
  })
  expect(config.limits.fixRounds).toBe(2)
  expect(sources['limits.fixRounds']).toBe('prose: "two failed reviews"')
})

test('mismatch 10: "do not ... without asking" is a stop entry', () => {
  const { config, sources } = draftConfig({
    scripts: {},
    makeTargets: [],
    ci: '',
    dirs: [],
    prose: ['Ask only when blocked by missing information, conflicting requirements, destructive data changes, new costs, or external actions requiring authorization.\nDo not deploy or send messages without asking. This overrides approval pauses below.'],
  })
  expect(config.stop).toEqual(['blocked by missing information', 'conflicting requirements', 'destructive data changes', 'new costs', 'external actions requiring authorization', 'deploy or send messages'])
  expect(sources['stop']).toContain('prose')
})

test('retain: defaults keep plans and drop briefs and superpowers; a wrong type is named', () => {
  const a = normalizeConfig({})
  expect(a.config.retain).toEqual({ plans: true, briefs: false, superpowers: false })
  const b = normalizeConfig({ retain: { briefs: true, plans: 'yes' } })
  expect(b.config.retain).toEqual({ plans: true, briefs: true, superpowers: false })
  expect(b.problems).toContain('retain.plans: expected a boolean, got string')
})

test('draftConfig flags a broad risky path: a top-level directory or a whole src tree, named in the source with the narrowing hint', () => {
  const { config, sources } = draftConfig({
    scripts: {},
    makeTargets: [],
    ci: '',
    dirs: ['apps', 'packages', 'services', 'docs'],
    prose: [
      'All of apps/web/src and packages/ touch auth and payment code; the migrations live in apps/web/migrations.',
      'The parser under services/pdf-renderer/src/ is risky too, and so is every lock in services/.',
    ],
  })
  expect(config.riskyPaths).toEqual(['apps/web/src/**', 'packages/**', 'apps/web/migrations/**', 'services/pdf-renderer/src/**', 'services/**'])
  expect(sources['riskyPaths']).toBe(
    'prose naming risky code (5 directories); apps/web/src/**, packages/**, services/pdf-renderer/src/**, services/** are broad: narrow to the auth, migration, payment or parser folders',
  )
  // A narrow path carries no warning.
  const narrow = draftConfig({ scripts: {}, makeTargets: [], ci: '', dirs: ['apps'], prose: ['The auth code under apps/web/src/server/auth is risky.'] })
  expect(narrow.sources['riskyPaths']).toBe('prose naming risky code (1 directory)')
  expect(draftConfig({ scripts: {}, makeTargets: [], ci: '', dirs: ['apps'], prose: ['Only apps/ holds auth code.'] }).sources['riskyPaths']).toBe(
    'prose naming risky code (1 directory); apps/** is broad: narrow to the auth, migration, payment or parser folders',
  )
})
