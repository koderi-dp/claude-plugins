// Helpers for the end-to-end scenarios: a checkout of the sandbox repository, real gh and git, and the real plugin
// loaded from this source folder into a headless `claude -p` session. Plain Node, no dependencies.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_DIR = resolve(HERE, '..')
export const REPO = process.env.PIPELINE_E2E_REPO ?? 'koderi-dp/pipeline-sandbox'
export const CLONE = resolve(process.env.PIPELINE_E2E_DIR ?? join(HERE, '..', '..', '..', 'target', 'e2e', REPO.split('/')[1]))
export const MODEL = process.env.PIPELINE_E2E_MODEL ?? 'haiku'
/** The model of the agent scenarios, where the model does the work and not only one tool call. */
export const AGENT_MODEL = process.env.PIPELINE_E2E_AGENT_MODEL ?? 'sonnet'
export const TOOL = 'mcp__pipeline__pipeline'
/** What every pull request and issue a scenario makes starts with, so a later run can find and close what was left. */
export const MARK = '[e2e]'
/** The tag in the sandbox that every scenario starts from: its main is put back to it before each one. */
export const BASELINE = 'e2e-baseline'
export const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)

export class Failed extends Error {}

/** Runs a program to its end and answers its output; throws with what it said when it fails and `okToFail` is not set. */
export function sh(cmd, args, { cwd = CLONE, okToFail = false, timeoutMs = 120_000, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, input, maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}`.trim()
  if (r.error && !okToFail) throw new Failed(`${cmd} ${args.join(' ')}: ${r.error.message}`)
  if (r.status !== 0 && !okToFail) throw new Failed(`${cmd} ${args.slice(0, 6).join(' ')} exited ${r.status}: ${`${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ') || out.slice(-300)}`)
  return out
}
export const git = (args, opts) => sh('git', args, opts)
export const gh = (args, opts) => sh('gh', args, opts)
export const ghJson = (args, opts) => JSON.parse(gh(args, opts) || 'null')

/** Git and gh answer a network blip with a failure; one more try after a pause is enough for a test run. */
export function retry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return fn()
    } catch (err) {
      if (i >= tries) throw err
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'])
    }
  }
}

// ---------- the record of a run: every session whole, and as text a person or a model can read ----------

/** Where this run's logs go: one folder per scenario, two files per session and a summary. Ignored by git (target/). */
export const LOG_DIR = resolve(HERE, '..', '..', '..', 'target', 'e2e', 'logs', STAMP)
const log = { scenario: 'setup', n: 0, sessions: [] }

/** Called by the runner before each scenario, so its sessions land in its own folder. */
export function startScenario(name) {
  log.scenario = name
  log.n = 0
}
export const sessionsOf = name => log.sessions.filter(s => s.scenario === name)

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters; the .jsonl has all of it)` : text)
const textOf = content => (typeof content === 'string' ? content : (content ?? []).map(p => p.text ?? (p.type === 'image' ? '[image]' : '')).join(''))

/** The session as text: the prompt, then every turn in order, with subagents' turns indented under the call that started them. */
function render({ label, model, prompt, events, stderr, status, ms }, totals) {
  const out = [`# ${label} · ${model} · exit ${status} · ${Math.round(ms / 1000)} s · ${totals.turns} turns · ${totals.tokens} tokens · $${totals.cost.toFixed(4)}`, '', '## Prompt', '', prompt, '', '## Session', '']
  const names = new Map()
  for (const m of events) {
    const pad = m.parent_tool_use_id ? '    ' : ''
    const who = m.parent_tool_use_id ? `subagent of ${names.get(m.parent_tool_use_id) ?? m.parent_tool_use_id}` : 'lead'
    const content = m?.message?.content
    if (m.type === 'system' && m.subtype === 'init') out.push(`[init] model ${m.model} · permission mode ${m.permissionMode} · plugins: ${(m.plugins ?? []).map(p => `${p.name} ${p.version ?? ''} (${p.source})`).join(', ')}`, '')
    else if (m.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text' && c.text.trim()) out.push(`${pad}[${who} says]`, ...clip(c.text.trim(), 6000).split('\n').map(l => pad + l), '')
        if (c.type === 'thinking' && c.thinking?.trim()) out.push(`${pad}[${who} thinks]`, ...clip(c.thinking.trim(), 3000).split('\n').map(l => pad + l), '')
        if (c.type === 'tool_use') {
          names.set(c.id, c.name === 'Agent' || c.name === 'Task' ? `${c.input?.subagent_type ?? 'agent'}` : c.name)
          out.push(`${pad}[${who} calls ${c.name}]`, ...clip(JSON.stringify(c.input, null, 2), 6000).split('\n').map(l => pad + l), '')
        }
      }
    } else if (m.type === 'user' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'tool_result') out.push(`${pad}[result of ${names.get(c.tool_use_id) ?? 'a tool'}${c.is_error ? ' · ERROR' : ''}]`, ...clip(textOf(c.content).trim(), 6000).split('\n').map(l => pad + l), '')
        else if (c.type === 'text' && c.text.trim()) out.push(`${pad}[to ${who}]`, ...clip(c.text.trim(), 6000).split('\n').map(l => pad + l), '')
      }
    } else if (m.type === 'result') out.push(`[end] ${m.subtype} · ${m.num_turns} turns · ${Math.round((m.duration_ms ?? 0) / 1000)} s`, '', clip(String(m.result ?? ''), 6000), '')
  }
  if (stderr.trim()) out.push('## stderr', '', clip(stderr.trim(), 4000), '')
  return out.join('\n')
}

/** Writes one session's raw stream (.jsonl) and its text (.md), and keeps its numbers for the summary. */
function record(session) {
  // A session can end more than once in the stream: the plugin renaming the session is a second, empty result.
  const ends = session.events.filter(m => m.type === 'result')
  const end = ends.reduce((best, m) => ((m.num_turns ?? 0) > (best.num_turns ?? -1) ? m : best), {})
  const u = end.usage ?? {}
  const totals = {
    turns: ends.reduce((n, m) => n + (m.num_turns ?? 0), 0),
    tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    fresh: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    cost: end.total_cost_usd ?? 0,
  }
  const uses = session.events.flatMap(m => (m.type === 'assistant' && Array.isArray(m.message?.content) ? m.message.content.filter(c => c.type === 'tool_use') : []))
  const dir = join(LOG_DIR, log.scenario)
  const base = `${String(++log.n).padStart(2, '0')}-${session.label.replace(/[^a-z0-9-]+/gi, '-')}`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${base}.jsonl`), session.raw)
    writeFileSync(join(dir, `${base}.md`), render(session, totals))
  } catch (err) {
    console.log(`    (the log of ${base} could not be written: ${err.message})`)
  }
  log.sessions.push({
    scenario: log.scenario,
    file: join(log.scenario, `${base}.md`),
    label: session.label,
    model: session.model,
    secs: Math.round(session.ms / 1000),
    ...totals,
    toolCalls: uses.length,
    subagents: uses.filter(c => c.name === 'Agent' || c.name === 'Task').length,
    errors: session.events.flatMap(m => (m.type === 'user' && Array.isArray(m.message?.content) ? m.message.content.filter(c => c.type === 'tool_result' && c.is_error) : [])).length,
  })
}

/** summary.md and summary.json for the run: per scenario the outcome, then every session with its numbers and file. */
export function writeSummary(outcome) {
  const lines = [`# pipeline e2e · ${STAMP} · ${REPO}`, '', `Plugin: ${PLUGIN_DIR}`, '', 'Tokens: everything the model read and wrote, cache reads included. Fresh: without the cache reads.', '', '| Scenario | Outcome | Time | Sessions | Turns | Tokens | Fresh | Cost |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const o of outcome) {
    const s = sessionsOf(o.name)
    const sum = k => s.reduce((n, x) => n + x[k], 0)
    lines.push(`| ${o.name} | ${o.error ? 'FAILED' : 'passed'} | ${o.secs} s | ${s.length} | ${sum('turns')} | ${sum('tokens')} | ${sum('fresh')} | $${sum('cost').toFixed(4)} |`)
  }
  const all = log.sessions
  lines.push(`| **total** | | ${outcome.reduce((n, o) => n + o.secs, 0)} s | ${all.length} | ${all.reduce((n, x) => n + x.turns, 0)} | ${all.reduce((n, x) => n + x.tokens, 0)} | ${all.reduce((n, x) => n + x.fresh, 0)} | $${all.reduce((n, x) => n + x.cost, 0).toFixed(4)} |`, '')
  for (const o of outcome.filter(o => o.error)) lines.push(`## ${o.name} failed`, '', o.error, '')
  lines.push('## Sessions', '', '| File | Model | Time | Turns | Tool calls | Subagents | Tool errors | Tokens | Fresh | Cost |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const x of all) lines.push(`| ${x.file.replace(/\\/g, '/')} | ${x.model} | ${x.secs} s | ${x.turns} | ${x.toolCalls} | ${x.subagents} | ${x.errors} | ${x.tokens} | ${x.fresh} | $${x.cost.toFixed(4)} |`)
  mkdirSync(LOG_DIR, { recursive: true })
  writeFileSync(join(LOG_DIR, 'summary.md'), `${lines.join('\n')}\n`)
  writeFileSync(join(LOG_DIR, 'summary.json'), `${JSON.stringify({ stamp: STAMP, repo: REPO, plugin: PLUGIN_DIR, outcome, sessions: all }, null, 2)}\n`)
}

/**
 * One headless session in the sandbox checkout with the plugin from this source folder. Answers the session's final
 * text and what every pipeline tool call returned, read from the stream so no model has to repeat it.
 */
export function claude(prompt, { timeoutMs = 20 * 60_000, allowed = [TOOL], model = MODEL, label = 'session' } = {}) {
  const args = ['-p', prompt, '--model', model, '--plugin-dir', PLUGIN_DIR, '--output-format', 'stream-json', '--verbose', '--allowedTools', ...allowed]
  const started = Date.now()
  const r = spawnSync('claude', args, { cwd: CLONE, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 })
  const events = []
  for (const line of `${r.stdout ?? ''}`.split('\n')) {
    try {
      events.push(JSON.parse(line))
    } catch {
      // not an event: a blank line, or text the CLI printed outside the stream
    }
  }
  record({ label, model, prompt, events, raw: `${r.stdout ?? ''}`, stderr: `${r.stderr ?? ''}`, status: r.error ? r.error.message : r.status, ms: Date.now() - started })
  if (r.error) throw new Failed(`claude: ${r.error.message}`)
  const calls = new Map()
  const results = []
  let final = ''
  for (const m of events) {
    const content = m?.message?.content
    if (m.type === 'assistant' && Array.isArray(content)) for (const c of content) if (c.type === 'tool_use') calls.set(c.id, c)
    if (m.type === 'user' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type !== 'tool_result' || calls.get(c.tool_use_id)?.name !== TOOL) continue
        const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map(p => p.text ?? '').join('')
        results.push({ input: calls.get(c.tool_use_id).input, text })
      }
    }
    // The model's last word, not the empty second ending a session rename adds.
    if (m.type === 'result' && ((m.num_turns ?? 0) > 0 || !final)) final = String(m.result ?? '')
  }
  if (r.status !== 0 && !results.length) throw new Failed(`claude exited ${r.status}: ${(final || `${r.stderr ?? ''}`).trim().slice(-400)}`)
  return { final, results }
}

/** A value as JSON with its keys in order, to compare two inputs whatever order their keys came in. */
const canonical = v => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x))

/** One call of the pipeline tool through a headless session: the text the tool returned. */
export function tool(input, opts) {
  const prompt = `Call the tool ${TOOL} exactly once with this JSON input and nothing else: ${JSON.stringify(input)} Do not call any other tool and do not retry. Then reply with the single word done.`
  // The small model that makes the call now and then sends another input than it was given (an id under the wrong
  // key). That is the driver's slip, not the plugin's: the call is made again, and a third slip fails the scenario.
  let results
  for (let attempt = 1; ; attempt++) {
    const ran = claude(prompt, { label: input.action, ...opts })
    if (!ran.results.length) throw new Failed(`the tool was not called: ${ran.final.slice(0, 300)}`)
    results = ran.results
    if (canonical(results[0].input) === canonical(input)) break
    console.log(`    ${input.action}: the driver sent ${JSON.stringify(results[0].input)} and got "${results[0].text.split('\n')[0].slice(0, 120)}"${attempt < 3 ? '; asking again' : ''}`)
    if (attempt >= 3) throw new Failed(`the driver model did not send the input it was given for ${input.action}, three times`)
  }
  const text = results[0].text
  console.log(`    ${input.action} → ${text.split('\n')[0].slice(0, 200)}`)
  return text
}

export function expect(cond, what) {
  if (!cond) throw new Failed(what)
}
export function expectMatch(text, re, what) {
  const m = re.exec(text)
  if (!m) throw new Failed(`${what}: got "${text.split('\n')[0].slice(0, 240)}"`)
  return m
}

/** The sandbox checkout on a clean main that matches origin, with nothing of an earlier run left on this machine. */
export function prepare() {
  if (!existsSync(join(CLONE, '.git'))) {
    mkdirSync(dirname(CLONE), { recursive: true })
    retry(() => sh('gh', ['repo', 'clone', REPO, CLONE, '--', '-q'], { cwd: dirname(CLONE) }))
  }
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    const wt = /^worktree (.+)$/.exec(line)?.[1]
    if (wt && resolve(wt) !== CLONE) git(['worktree', 'remove', '--force', wt], { okToFail: true })
  }
  git(['worktree', 'prune'])
  retry(() => git(['fetch', '-q', '--prune', '--tags', '--force', 'origin']))
  // Every scenario starts from the same code: the sandbox's main is put back to the baseline tag, so the same
  // task can be built again and two runs can be compared.
  const base = git(['rev-parse', '-q', '--verify', `refs/tags/${BASELINE}^{commit}`], { okToFail: true })
  if (!base) throw new Failed(`the sandbox has no ${BASELINE} tag: make one with "node plugins/pipeline/e2e/run.mjs baseline"`)
  if (git(['rev-parse', 'origin/main']) !== base) {
    retry(() => git(['push', '-q', '--force', 'origin', `${base}:refs/heads/main`]))
    retry(() => git(['fetch', '-q', '--prune', 'origin']))
  }
  git(['checkout', '-q', '-f', 'main'])
  git(['reset', '-q', '--hard', 'origin/main'])
  git(['clean', '-qfdx'])
  // The plugin's own state for this checkout: the issue cache, the ledgers, the live file.
  for (const p of ['pipeline', 'pipeline-live.json', 'pipeline.lock']) rmSync(join(CLONE, '.git', p), { recursive: true, force: true })
  for (const b of git(['branch', '--format=%(refname:short)']).split('\n').filter(b => b && b !== 'main')) git(['branch', '-D', b], { okToFail: true })
}

/** Closes what earlier runs left open on GitHub: the marked pull requests (with their branches) and the marked issues. */
export function sweep() {
  for (const pr of ghJson(['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title'])) {
    if (pr.title.startsWith(MARK)) gh(['pr', 'close', String(pr.number), '--delete-branch'], { okToFail: true })
  }
  for (const issue of ghJson(['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title'])) {
    if (issue.title.startsWith(MARK)) gh(['issue', 'close', String(issue.number), '--reason', 'not planned'], { okToFail: true })
  }
  // The branches the scenarios pushed: their own (e2e/…) and the item branches of the marked issues (feat/<n>).
  const marked = new Set(ghJson(['issue', 'list', '--state', 'all', '--limit', '300', '--json', 'number,title']).filter(i => i.title.startsWith(MARK)).map(i => String(i.number)))
  const heads = git(['ls-remote', '--heads', 'origin']).split('\n').map(l => /refs\/heads\/(.+)$/.exec(l)?.[1]).filter(Boolean)
  const gone = heads.filter(b => b.startsWith('e2e/') || marked.has(/^feat\/(\d+)$/.exec(b)?.[1]))
  if (gone.length) git(['push', '-q', 'origin', ...gone.map(b => `:refs/heads/${b}`)], { okToFail: true })
}

/** Writes files under a folder; a value that is a function is given the file's current text and answers the new one. */
function writeFiles(root, files) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof text === 'function' ? text(existsSync(file) ? readFileSync(file, 'utf8') : '') : text)
  }
}

/**
 * Tags the sandbox's main as the baseline every scenario starts from, without the files earlier versions of these
 * tests left there. Run once, and again whenever the sandbox itself is changed on purpose.
 */
export function makeBaseline() {
  retry(() => git(['fetch', '-q', '--prune', 'origin']))
  git(['checkout', '-q', '-f', 'main'])
  git(['reset', '-q', '--hard', 'origin/main'])
  const stale = ['src/e2e.js', 'src/e2e.test.js', 'docs/e2e.md'].filter(p => existsSync(join(CLONE, p)))
  if (stale.length) {
    git(['rm', '-q', ...stale])
    git(['commit', '-q', '-m', 'Sandbox baseline: without the files of the earlier end-to-end tests'])
    retry(() => git(['push', '-q', 'origin', 'main']))
  }
  git(['tag', '-f', BASELINE])
  retry(() => git(['push', '-q', '--force', 'origin', `refs/tags/${BASELINE}`]))
  return git(['rev-parse', '--short', 'HEAD'])
}

/** A branch off origin/main with the given files, pushed, and a pull request for it with no issue behind it. */
export function openPr({ branch, files, title, body }) {
  git(['checkout', '-q', '-B', branch, 'origin/main'])
  writeFiles(CLONE, files)
  git(['add', '-A'])
  git(['commit', '-q', '-m', title])
  retry(() => git(['push', '-q', '-f', '-u', 'origin', branch]))
  const url = retry(() => gh(['pr', 'create', '--title', title, '--body', body, '--base', 'main', '--head', branch]))
  git(['checkout', '-q', 'main'])
  return Number(/(\d+)\s*$/.exec(url)[1])
}

export const issue = n => ghJson(['issue', 'view', String(n), '--json', 'number,title,body,state,stateReason,labels,comments'])
export const pull = n => ghJson(['pr', 'view', String(n), '--json', 'number,state,body,headRefName,closingIssuesReferences'])
export const labelsOf = i => i.labels.map(l => l.name)

// ---------- the fixed inputs: the same request, spec and change in every run, so runs can be compared ----------

/** The one code task of every scenario that builds something. */
export const TASK = {
  title: `${MARK} Add a shout helper`,
  request: 'We need a shout(s) helper in src/text.js that upper-cases a string and appends an exclamation mark, with a test.',
  spec: `## What\n\nAdd \`shout(s)\` to \`src/text.js\`: the string upper-cased with an exclamation mark appended, so \`shout("hi")\` is \`HI!\`.\n\n## Why\n\nA small, fixed task for the end-to-end tests of the pipeline plugin.\n\n## Acceptance\n\n- [ ] \`shout("hi")\` is \`HI!\`, with a test in \`src/text.test.js\`\n- [ ] \`node --test\` passes\n\n## Out of scope\n\nEvery other file and every other helper.\n\n## Open\n`,
  /** Whether a text.js carries the helper. */
  isBuilt: text => /export\s+(?:function|const)\s+shout\b/.test(text),
}

/** The task built by the script in place of a model: the helper and its test, added to the baseline's files. */
export const shoutChange = () => ({
  'src/text.js': was => `${was.trimEnd()}\n\nexport function shout(s) {\n  return String(s).toUpperCase() + '!';\n}\n`,
  'src/text.test.js': was => `${was.trimEnd()}\n\nimport { shout } from './text.js';\ntest('shout', () => {\n  assert.equal(shout('hi'), 'HI!');\n});\n`,
})
/** A change the CI workflow ignores. */
export const DOCS = { title: `${MARK} Docs: usage notes`, body: 'A short page on how to use the helpers and run the tests.' }
export const docsChange = () => ({ 'docs/usage.md': '# Usage\n\nImport a helper from `src/text.js` or `src/math.js`.\n\nRun the tests with `node --test`.\n' })

/**
 * Changes the pipeline config in this checkout only, never on GitHub: the tool reads the main checkout's file, and
 * `prepare` puts the committed one back before the next scenario. The sandbox commits no `mode`, so a scenario
 * that sets none runs on the plugin's default.
 */
export function setConfig(patch) {
  const file = join(CLONE, 'docs', 'pipeline', 'config.json')
  writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }, null, 2)}
`)
}

/** Where the tool makes the worktree of an item. */
export const worktreeOf = id => join(CLONE, '.claude', 'worktrees', String(id))

/** Writes files into a worktree and commits them there: the building, done by the script in place of a model. */
export function commitIn(wt, files, message) {
  writeFiles(wt, files)
  git(['add', '-A'], { cwd: wt })
  git(['commit', '-q', '-m', message], { cwd: wt })
}
