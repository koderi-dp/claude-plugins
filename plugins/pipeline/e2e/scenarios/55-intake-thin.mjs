import { AGENT_MODEL, MARK, claude, expect, git, issue, labelsOf, tool } from '../lib.mjs'

const TITLE = `${MARK} Add date helpers`

export default {
  name: 'intake-thin',
  tier: 'agent',
  checks: 'a request that leaves much open is recorded, held by a question on the issue and asked about; nothing is built; an answer ends the hold',
  async run() {
    const { results, final } = claude(
      // Thin on purpose: which helpers, which formats, which file and what input are all left open.
      `We need some date helpers. Title the item exactly "${TITLE}".`,
      { label: 'intake-thin', model: AGENT_MODEL, allowed: ['mcp__pipeline__pipeline', 'Read', 'Glob', 'Grep', 'Skill'] },
    )
    const added = results.map(r => /^added (\d+)/.exec(r.text)?.[1]).find(Boolean)
    expect(added, `the intake added no item: ${results.map(r => r.text.split('\n')[0]).join(' | ') || final.slice(0, 300)}`)
    console.log(`    ${results.map(r => r.input.action).join(', ')} → issue ${added}`)

    const made = issue(added)
    expect(made.title === TITLE, `issue ${added} has the title "${made.title}"`)
    expect(labelsOf(made).includes('pipeline'), `issue ${added} has no queue label`)
    // Recorded and held: the question is on the issue, so a later run stops at it and does not build on a guess.
    expect(made.comments.some(c => c.body.trimStart().startsWith('<!-- pipeline:question -->')), `issue ${added} has no question comment`)
    expect(labelsOf(made).includes('pipeline:needs-info'), `issue ${added} is not held: no pipeline:needs-info label`)
    // Asked in the session too: the last message carries the question after "open:" and is not "open: none".
    expect(/open:\s*(?!none)\S[\s\S]*\?/.test(final), `the intake asked nothing in its answer: ${final.slice(0, 300)}`)
    expect(!results.some(r => r.input.action === 'answer'), 'the intake answered its own question')
    expect(!results.some(r => ['begin', 'ship', 'plan', 'start'].includes(r.input.action)), 'the intake started the build')
    expect(!git(['ls-remote', '--heads', 'origin', `feat/${added}`]), `a branch feat/${added} was pushed`)

    // What the user says in the session goes on the issue through the tool, and that ends the hold.
    const answered = tool({ action: 'answer', id: added, text: 'Only formatIso(date), in src/date.js, for Date objects.' })
    expect(/ready · answer on the issue/.test(answered), `answer did not end the hold: ${answered.split('\n')[0]}`)
    const after = issue(added)
    expect(!labelsOf(after).includes('pipeline:needs-info'), `issue ${added} still carries pipeline:needs-info after the answer`)
    expect(after.comments.some(c => c.body.startsWith('Answered in the session: Only formatIso(date)')), `issue ${added} has no answer comment`)

    tool({ action: 'remove', id: added, text: 'an end-to-end test, not a request' })
  },
}
