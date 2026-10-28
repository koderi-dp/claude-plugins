import { expect, mock, test } from 'claude-code/testing'

const TIERS = ['auto', 'light', 'medium', 'careful', 'heavy', 'fable']
const row = (field: string, value: string, options: string[]) => ({
  key: `superpowers-flow.${field}`,
  label: field,
  kind: 'choice',
  value,
  options,
  provider: { plugin: 'superpowers-flow', tier: 'user' },
  isLocked: false,
})
const ROWS = [
  row('coderTier', 'auto', TIERS),
  row('mediumModel', 'default', ['default', 'haiku', 'sonnet', 'opus', 'fable']),
  row('notify', 'off', ['off', 'milestones']),
  { ...row('language', 'auto', ['auto', 'en']), key: 'someone-else.language' },
]
const SKILL = '# superpowers-flow\n\n## 1. Tier instead of model\n\n## 2. Progress bar\n'

test('/flow-config lists this plugin\'s settings only', async ($, on) => {
  mock.clock(on)
  on('config.list', () => ({ value: ROWS }))
  const out = String(((await $.command.run({ command: 'flow-config', args: '' } as never)) as { text?: string }).text)
  expect(out).toContain('coderTier   = auto   (auto, light, medium, careful, heavy, fable)')
  expect(out).toContain('mediumModel = default')
  expect(out).not.toContain('language')
})

test('/flow-config saves a change and the skill picks it up in this session', async ($, on) => {
  mock.clock(on)
  on('config.list', () => ({ value: ROWS }))
  const saved: [string, unknown][] = []
  on('config.set', (_$, e) => {
    const { key, value } = e as { key: string; value: unknown }
    saved.push([key, value])
    return { value } as never
  })
  on('skill.prompt', (_$, e) => ({ text: (e as { text: string }).text }))

  const out = String(((await $.command.run({ command: 'flow-config', args: 'coderTier=medium mediumModel=gpt oops' } as never)) as { text?: string }).text)
  expect(saved).toEqual([['superpowers-flow.coderTier', 'medium']])
  expect(out).toContain('mediumModel: takes default, haiku, sonnet, opus, fable')
  expect(out).toContain('oops: write it as key=value')
  expect(out).toContain('coderTier   = medium')

  const skill = await $.skill.prompt({ skill: 'superpowers-flow:superpowers-flow', text: SKILL } as never)
  expect((skill as { text: string }).text).toContain('- Coders (implementers, and fixers on a return round): `sp-medium`.')
})

test('/flow-config reset puts every setting back to its default', async ($, on) => {
  mock.clock(on)
  // Reset includes `language`, which detects the panel's language again.
  mock.env(on, { LANG: 'en_US.UTF-8' })
  on('settings.read', async () => ({ value: {} }) as never)
  on('config.list', () => ({ value: [row('coderTier', 'heavy', TIERS), row('notify', 'milestones', ['off', 'milestones'])] }))
  const saved: [string, unknown][] = []
  on('config.set', (_$, e) => {
    const { key, value } = e as { key: string; value: unknown }
    saved.push([key, value])
    return { value } as never
  })
  await $.command.run({ command: 'flow-config', args: 'reset' } as never)
  expect(saved).toEqual([
    ['superpowers-flow.notify', 'off'],
    ['superpowers-flow.coderTier', 'auto'],
  ])
})
