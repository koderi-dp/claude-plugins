import { expect, mock, test } from 'claude-code/testing'

import { skillWithSettings, tierSettingsOf } from './tiers'

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
