import type { Register } from 'claude-code'

const DESCRIPTION = 'Show or hide the board panel; `status`, `status all`, `status <id>`, `show <id>`, `find <text>`, `init`, `open`'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'board', description: DESCRIPTION })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'board' }, async () => ({ text: 'board: not wired yet' }))
}
