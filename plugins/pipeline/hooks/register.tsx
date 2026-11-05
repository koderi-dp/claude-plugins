import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Config } from '../types'

const DESCRIPTION = 'The pipeline: `status`, `panel`, `config`, `init`, `add`, `next`, `run`, `migrate`, `stop`, `move`, `park`, `unpark`'
const CONFIG_FILE = 'docs/pipeline/config.json'

const root = atom({ plugin: 'pipeline', key: 'root' } as const, '')
const config = atom({ plugin: 'pipeline', key: 'config' } as const, null as Config | null)
const fileError = atom({ plugin: 'pipeline', key: 'fileError' } as const, null as string | null)

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** The main checkout's root, even from a worktree; the session's root without a repository. */
async function resolveRoot($: EngineInterface): Promise<string> {
  let repoRoot: string | undefined
  try {
    repoRoot = (await $.session.repo())?.root
  } catch {}
  const found = slashes(repoRoot ?? (await $.session.root()))
  await update($, root, () => found)
  return found
}

/** The 1-based line a JSON parse error names, from its line or its position; 1 when it gives neither. */
export function errorLine(text: string, message: string): number {
  const line = /line (\d+)/i.exec(message)
  if (line) return Number(line[1])
  const pos = /position (\d+)/i.exec(message)
  if (pos) return text.slice(0, Number(pos[1])).split('\n').length
  return 1
}

/** Reads the config file: missing gives null and no error, bad JSON gives the error with its line. */
async function loadConfig($: EngineInterface, found: string): Promise<void> {
  const path = `${found}/${CONFIG_FILE}`
  if (!(await $.fs.exists(path))) {
    await update($, config, () => null)
    await update($, fileError, () => null)
    return
  }
  const text = await $.fs.read(path)
  try {
    const parsed = JSON.parse(text) as Config
    await update($, config, () => parsed)
    await update($, fileError, () => null)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, config, () => null)
    await update($, fileError, () => `${CONFIG_FILE}: line ${errorLine(text, message)}: ${message}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({ name: 'pipeline', description: DESCRIPTION, argumentHint: 'subcommand' })
      await loadConfig($, await resolveRoot($))
    } catch {}
    return started
  })

  on('command.run', { command: 'pipeline' }, async () => {
    try {
      return { text: 'pipeline: not built yet' }
    } catch {
      return { text: 'pipeline: failed' }
    }
  })
}
