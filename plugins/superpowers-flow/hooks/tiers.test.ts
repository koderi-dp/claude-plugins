import { expect, mock, test } from 'claude-code/testing'

import { CONFIG_DEFAULTS, effectiveOf, skillWithSettings, tierSettingsOf } from './tiers'

const SKILL = '# superpowers-flow\n\n## 1. Tier instead of model\n\nthe table\n\n## 2. Progress bar\n\nreport it'
const describe = (t: string) => `Model-of-${t}`

test('tiers: settings at their defaults leave every tier as its agent file says', () => {
  const set = tierSettingsOf({ lightModel: 'default', lightEffort: 'default', coderTier: 'auto' })
  expect(set.light).toEqual({ model: undefined, effort: undefined })
  expect(skillWithSettings(SKILL, { coderTier: 'auto' }, set, describe)).toBe(SKILL)
})

test('tiers: unknown values are ignored', () => {
  const set = tierSettingsOf({ lightModel: 'gpt', heavyEffort: 'extreme' })
  expect(set.light.model).toBeUndefined()
  expect(set.heavy.effort).toBeUndefined()
})

test('tiers: roles and tier models go into the skill before section 2', () => {
  const options = { coderTier: 'medium', reviewerTier: 'careful', finalReviewTier: 'auto', lightModel: 'sonnet', lightEffort: 'medium' }
  const set = tierSettingsOf(options)
  expect(set.light).toEqual({ model: 'sonnet', effort: 'medium' })

  const text = skillWithSettings(SKILL, options, set, describe)
  expect(text).toContain('- Coders (implementers, and fixers on a return round): `sp-medium`.')
  expect(text).toContain('- Task reviewers and re-reviewers: `sp-careful`.')
  expect(text).not.toContain('final whole-branch review: `sp-')
  expect(text).toContain('- `sp-light` runs on Model-of-light.')
  expect(text.indexOf('## Settings from the user')).toBeLessThan(text.indexOf('## 2. Progress bar'))
})

test('tiers: taskReview each changes nothing; combined and final go into the skill', () => {
  const set = tierSettingsOf({})
  expect(skillWithSettings(SKILL, { taskReview: 'each' }, set, describe)).toBe(SKILL)
  expect(skillWithSettings(SKILL, { taskReview: 'combined' }, set, describe)).toContain('dispatch **one** reviewer')
  const text = skillWithSettings(SKILL, { taskReview: 'final' }, set, describe)
  expect(text).toContain('Task reviews are off for this run')
  expect(text).toContain('The final whole-branch review still runs')
  expect(text.indexOf('## Settings from the user')).toBeLessThan(text.indexOf('## 2. Progress bar'))
})

test('tiers: profiles resolve every knob; a value the user set wins', () => {
  expect(effectiveOf({})).toEqual({ taskReview: 'each', parallel: 'off', batchTasks: 'off', reReview: 'always', testScope: 'full', runner: 'subagent' })
  expect(effectiveOf({ profile: 'fast' })).toMatchObject({ taskReview: 'final', runner: 'worktree', reviewerTier: 'light', finalReviewTier: 'careful' })
  expect(effectiveOf({ profile: 'fast', taskReview: 'combined', reviewerTier: 'heavy', runner: 'session' })).toMatchObject({ taskReview: 'combined', reviewerTier: 'heavy', runner: 'session' })
  // `profile` and unknown values follow the profile.
  expect(effectiveOf({ profile: 'balanced', taskReview: 'profile', parallel: 'sideways' })).toMatchObject({ taskReview: 'combined', parallel: 'independent' })
  expect(effectiveOf({ profile: 'nope' }).taskReview).toBe('each')
})

test('tiers: the fast profile puts every knob and its roles into the skill', () => {
  const text = skillWithSettings(SKILL, { profile: 'fast' }, tierSettingsOf({}), describe)
  for (const part of ['profile `fast`', 'Task reviews are off', 'Independent slices run at once', 'Small tasks are batched', 'Small fixes are checked by you', 'Targeted tests per task', 'Slices run in worktrees', '`Worktree: <absolute path of that worktree>`'])
    expect(text).toContain(part)
  expect(text).toContain('- Task reviewers and re-reviewers: `sp-light`.')
  expect(text).toContain('- The final whole-branch review: `sp-careful`.')
  expect(text.indexOf('## Settings from the user')).toBeLessThan(text.indexOf('## 2. Progress bar'))
})

test('tiers: parallel words follow the runner; session gets its launch line and brief', () => {
  const inPlace = skillWithSettings(SKILL, { parallel: 'independent' }, tierSettingsOf({}), describe)
  expect(inPlace).toContain('Independent tasks run at once')
  expect(inPlace).not.toContain('worktree')
  const session = skillWithSettings(SKILL, { profile: 'balanced', runner: 'session' }, tierSettingsOf({}), describe)
  expect(session).toContain('claude -p "<slice brief>" --permission-mode <mode>')
  expect(session).toContain('`run: "<run id>"`, `slice: "<slice>"`')
  expect(session).not.toContain('Slices run in worktrees')
})

test('tiers: reset puts every new setting back to profile', () => {
  expect(CONFIG_DEFAULTS).toMatchObject({ profile: 'thorough', taskReview: 'profile', parallel: 'profile', batchTasks: 'profile', reReview: 'profile', testScope: 'profile', runner: 'profile' })
})

// With every setting at its default the spawn goes out as the controller asked:
// no model is forced on the worker.
test('tiers: with default settings a spawn keeps its own model', async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const models: (string | undefined)[] = []
  on('agent.spawn', (_$, e) => {
    models.push((e as { model?: string }).model)
    return { model: 'claude-opus-5-5', agentId: 'a1' }
  })
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Task 1', subagentType: 'superpowers-flow:sp-light', provider: 'engine', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  expect(models).toEqual([undefined])
})

// The skill hook leaves the skill alone when nothing is set.
test('tiers: the skill text passes through unchanged with default settings', async ($, on) => {
  on('skill.prompt', (_$, e) => ({ text: (e as { text: string }).text }))
  const out = await $.skill.prompt({ skill: 'superpowers-flow:superpowers-flow', text: SKILL } as never)
  expect((out as { text: string }).text).toBe(SKILL)
})
