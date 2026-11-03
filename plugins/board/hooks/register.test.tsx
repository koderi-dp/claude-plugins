import { expect, test } from 'claude-code/testing'

test('the plugin registers its command', async ($, on) => {
  const names: string[] = []
  on('command.register', (_$, e) => {
    names.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  await $.session.start({ cwd: 'C:/p/main', surface: 'terminal', isInteractive: true } as never)
  expect(names).toContain('board')
})
