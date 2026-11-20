import { AGENT_MODEL, TASK, claude, expect, expectMatch, git, issue, retry, setConfig, tool } from '../lib.mjs'

export default {
  name: 'next-full',
  tier: 'agent',
  checks: 'mode full, the default, with models doing the work: a plan, an implementer subagent, the final review, the gate and a merged pull request',
  async run() {
    // The flow is what is tested, not the quality of a review: every role on the agent model, at medium effort.
    const role = { model: AGENT_MODEL, effort: 'medium' }
    setConfig({ models: { implementer: role, reviewer: role, final: role, escalate: role } })
    const id = expectMatch(tool({ action: 'add', item: { title: TASK.title, size: 'S' }, text: TASK.spec }), /^added (\d+)/, 'add did not answer the new issue')[1]

    // In words, not as /pipeline run: a headless session ends before the prompt the command submits is sent.
    const { results, final } = claude(`Run pipeline item ${id} now with the pipeline:pipeline-run skill, from begin until it is merged and closed. Do not ask me anything.`, {
      label: 'run',
      model: AGENT_MODEL,
      timeoutMs: 40 * 60_000,
      allowed: ['mcp__pipeline__pipeline', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Skill', 'Agent', 'EnterWorktree', 'ExitWorktree'],
    })
    const actions = results.map(r => r.input.action)
    console.log(`    ${actions.join(', ')}`)
    const last = results.at(-1)?.text.split('\n')[0] ?? final.slice(0, 300)
    for (const step of ['begin', 'plan', 'accept', 'ship']) expect(actions.includes(step), `the run never called ${step}, so it was not the full loop: ${actions.join(', ')} · "${last}"`)
    expect(results.some(r => r.input.action === 'plan' && /pipeline:implementer/.test(r.text)), 'plan did not hand the task to an implementer')
    expect(results.some(r => r.text.includes(`${id} merged`)), `the run did not end with the item merged: "${last}"`)

    expect(issue(id).state === 'CLOSED', `issue ${id} is still open`)
    retry(() => git(['fetch', '-q', 'origin']))
    expect(TASK.isBuilt(git(['show', 'origin/main:src/text.js'])), 'origin/main does not carry the shout helper')
  },
}
