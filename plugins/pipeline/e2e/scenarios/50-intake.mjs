import { AGENT_MODEL, TASK, claude, expect, git, issue, labelsOf, tool } from '../lib.mjs'

export default {
  name: 'intake',
  tier: 'agent',
  checks: 'a request in plain words becomes a labelled issue with a spec comment, and nothing is built',
  async run() {
    const { results, final } = claude(
      // In words, not as /pipeline add: a headless session ends before the prompt the command submits is sent.
      `${TASK.request} Title the item exactly "${TASK.title}".`,
      { label: 'intake', model: AGENT_MODEL, allowed: ['mcp__pipeline__pipeline', 'Read', 'Glob', 'Grep', 'Skill'] },
    )
    const added = results.map(r => /^added (\d+)/.exec(r.text)?.[1]).find(Boolean)
    expect(added, `the intake added no item: ${results.map(r => r.text.split('\n')[0]).join(' | ') || final.slice(0, 300)}`)
    console.log(`    ${results.map(r => r.input.action).join(', ')} → issue ${added}`)

    const made = issue(added)
    expect(made.title === TASK.title, `issue ${added} has the title "${made.title}"`)
    expect(labelsOf(made).includes('pipeline'), `issue ${added} has no queue label`)
    expect(made.comments.some(c => c.body.includes('<!-- pipeline:spec -->') && /shout/i.test(c.body)), `issue ${added} has no spec comment about shout`)
    expect(!results.some(r => ['begin', 'ship', 'plan', 'start'].includes(r.input.action)), 'the intake started the build')
    expect(!git(['ls-remote', '--heads', 'origin', `feat/${added}`]), `a branch feat/${added} was pushed`)

    tool({ action: 'remove', id: added, text: 'an end-to-end test, not a request' })
  },
}
