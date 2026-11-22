// Runs the pipeline tool on the Node host against a throwaway git repository: `bun hosts/node/smoke.ts`.
// Not a unit test (those run under `claude plugin test`): it proves the core works outside Claude Code.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runTool } from '../../core/engine'
import { inSession, nodeHost } from './host'

const dir = mkdtempSync(path.join(os.tmpdir(), 'pipeline-smoke-'))
const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
git('init', '-q', '-b', 'main')
git('-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'start')

const said: string[] = []
const check = (name: string, ok: boolean, got: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${String(got).slice(0, 300)}`}`)
  if (!ok) process.exitCode = 1
}
const as = (id: string) => nodeHost({ id, cwd: dir, notify: t => void said.push(t) })

await inSession('one', async () => {
  const h = as('one')
  const init = await runTool(h, { action: 'init' })
  check('init writes the config', /config\.json/.test(init) && existsSync(path.join(dir, 'docs/pipeline/config.json')), init)
  const added = await runTool(h, { action: 'add', item: { title: 'Say hello', size: 'S' }, text: '## What\nPrint hello.\n\n## Acceptance\n- prints hello\n' })
  check('add answers the new id', /^added /.test(added), added)
  const got = JSON.parse(await runTool(h, { action: 'get' })) as { next?: { id: string; title: string }[] }
  check('get lists the item as next', got.next?.[0]?.title === 'Say hello', JSON.stringify(got).slice(0, 300))
  const status = await runTool(h, { action: 'status' })
  check('status is text', /Say hello|ready/i.test(status), status)
  check('BACKLOG.md is written', readFileSync(path.join(dir, 'docs/pipeline/BACKLOG.md'), 'utf8').includes('Say hello'), '')
})
// A second session in the same process keeps its own values.
await inSession('two', async () => {
  const got = JSON.parse(await runTool(as('two'), { action: 'get' })) as { next?: { title: string }[] }
  check('a second session reads the same backlog', got.next?.[0]?.title === 'Say hello', JSON.stringify(got).slice(0, 300))
})
console.log(`folder: ${dir}`)
