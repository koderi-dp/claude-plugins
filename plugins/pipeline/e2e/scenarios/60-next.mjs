import { AGENT_MODEL, TASK, claude, expect, expectMatch, git, issue, retry, setConfig, tool } from '../lib.mjs'

export default {
  name: 'next',
  tier: 'agent',
  checks: 'mode direct: the model runs one ready item from begin to a merged pull request',
  async run() {
    setConfig({ mode: 'direct' })
    const id = expectMatch(tool({ action: 'add', item: { title: TASK.title, size: 'S' }, text: TASK.spec }), /^added (\d+)/, 'add did not answer the new issue')[1]

    // In words, not as /pipeline run: a headless session ends before the prompt the command submits is sent.
    const { results, final } = claude(`Run pipeline item ${id} now with the pipeline:pipeline-run skill, from begin until it is merged and closed. Do not ask me anything.`, {
      label: 'run',
      model: AGENT_MODEL,
      timeoutMs: 30 * 60_000,
      allowed: ['mcp__pipeline__pipeline', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Skill', 'Agent', 'EnterWorktree', 'ExitWorktree'],
    })
    console.log(`    ${results.map(r => r.input.action).join(', ')}`)
    const last = results.at(-1)?.text.split('\n')[0] ?? final.slice(0, 300)
    expect(results.some(r => r.text.includes(`${id} merged`)), `the run did not end with the item merged: "${last}"`)

    expect(issue(id).state === 'CLOSED', `issue ${id} is still open`)
    retry(() => git(['fetch', '-q', 'origin']))
    expect(TASK.isBuilt(git(['show', 'origin/main:src/text.js'])), 'origin/main does not carry the shout helper')
  },
}
