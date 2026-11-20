// End-to-end tests of the pipeline plugin against a real GitHub repository (the sandbox), with the plugin loaded
// from this source folder. Usage, from the repository root:
//
//   node plugins/pipeline/e2e/run.mjs            the tool scenarios
//   node plugins/pipeline/e2e/run.mjs all        every scenario, the agent ones included
//   node plugins/pipeline/e2e/run.mjs adopt next the named scenarios
//   node plugins/pipeline/e2e/run.mjs list       the scenarios and what each checks
//   node plugins/pipeline/e2e/run.mjs baseline   tag the sandbox's main as the state every scenario starts from
//
// Every run is the same run: each scenario first puts the sandbox's main back to the baseline tag (a force push)
// and uses the same request, spec and change, so two runs differ only where the plugin or the model did.
//
// Every session of a run is kept under target/e2e/logs/<run>/<scenario>/: the raw stream (.jsonl) and the same as
// text (.md: every turn, tool call, result and subagent), with summary.md on top: outcome, time, tokens and cost.
//
// Needs `claude` (logged in), `gh` (logged in, with write access to the sandbox) and `git` on PATH.

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BASELINE, CLONE, Failed, LOG_DIR, MODEL, makeBaseline, PLUGIN_DIR, REPO, prepare, sessionsOf, startScenario, sweep, writeSummary } from './lib.mjs'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'scenarios')
const scenarios = []
for (const f of readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()) scenarios.push((await import(pathToFileURL(join(dir, f)).href)).default)

const args = process.argv.slice(2)
if (args[0] === 'list') {
  for (const s of scenarios) console.log(`${s.name.padEnd(14)} ${s.tier.padEnd(6)} ${s.checks}`)
  process.exit(0)
}
if (args[0] === 'baseline') {
  console.log(`${REPO}: main at ${makeBaseline()} is now the ${BASELINE} tag every scenario starts from`)
  process.exit(0)
}
const unknown = args.filter(a => a !== 'all' && !scenarios.some(s => s.name === a))
if (unknown.length) {
  console.error(`unknown scenario: ${unknown.join(', ')} (see: run.mjs list)`)
  process.exit(2)
}
const chosen = args.includes('all') ? scenarios : args.length ? scenarios.filter(s => args.includes(s.name)) : scenarios.filter(s => s.tier === 'tool')

console.log(`pipeline e2e · ${REPO} · plugin ${PLUGIN_DIR} · model ${MODEL}`)
console.log(`checkout ${CLONE}`)
console.log(`logs     ${LOG_DIR}`)
prepare()
sweep()

const outcome = []
for (const s of chosen) {
  const started = Date.now()
  console.log(`\n▶ ${s.name} (${s.tier}): ${s.checks}`)
  let error = null
  try {
    prepare()
    startScenario(s.name)
    await s.run()
  } catch (err) {
    error = err instanceof Failed ? err.message : (err?.stack ?? String(err))
  }
  const secs = Math.round((Date.now() - started) / 1000)
  console.log(error ? `✘ ${s.name} failed after ${secs} s: ${error}` : `✔ ${s.name} passed in ${secs} s`)
  const ran = sessionsOf(s.name)
  const sum = k => ran.reduce((n, x) => n + x[k], 0)
  console.log(`    ${ran.length} sessions · ${sum('turns')} turns · ${sum('tokens')} tokens · $${sum('cost').toFixed(4)}`)
  outcome.push({ name: s.name, error, secs })
  // After every scenario, so a run that is stopped half way still leaves its summary.
  writeSummary(outcome)
}
sweep()

const failed = outcome.filter(o => o.error)
console.log(`\n${outcome.length - failed.length} passed, ${failed.length} failed${failed.length ? `: ${failed.map(o => o.name).join(', ')}` : ''}`)
console.log(`logs: ${LOG_DIR} (summary.md first)`)
process.exit(failed.length ? 1 : 0)
