import { TASK, expect, expectMatch, issue, labelsOf, openPr, pull, shoutChange, tool } from '../lib.mjs'

export default {
  name: 'adopt',
  tier: 'tool',
  checks: 'a pull request opened without an issue becomes an item; merge waits for green CI, merges and closes it',
  async run() {
    const pr = openPr({ branch: 'e2e/shout', files: shoutChange(), title: TASK.title, body: 'Adds shout(s) to src/text.js, with a test. Opened with no issue behind it.' })
    const adopted = tool({ action: 'adopt', pr: `#${pr}` })
    const id = expectMatch(adopted, new RegExp(`^adopted PR #${pr} as (\\d+) · review · branch e2e/shout`), 'adopt did not answer the adopted item')[1]

    const made = issue(id)
    expect(made.title === TASK.title, `issue ${id} has the title "${made.title}"`)
    expect(labelsOf(made).includes('pipeline'), `issue ${id} has no queue label`)
    expect(labelsOf(made).includes('pipeline:building'), `issue ${id} is not labelled as in flight`)
    expect(pull(pr).closingIssuesReferences.some(i => String(i.number) === id), `PR ${pr} does not close issue ${id}`)
    expectMatch(tool({ action: 'adopt', pr: `#${pr}` }), /^refused: PR #\d+ already belongs to/, 'a second adopt was not refused')

    const merged = tool({ action: 'merge', item: id })
    expect(merged.includes(`${id} merged`) && merged.includes('CI green'), `merge did not end with a green merge: "${merged.split('\n')[0]}"`)
    expect(pull(pr).state === 'MERGED', `PR ${pr} is not merged`)
    const closed = issue(id)
    expect(closed.state === 'CLOSED', `issue ${id} is still open`)
    expect(!labelsOf(closed).includes('pipeline:building'), `issue ${id} still carries pipeline:building`)
  },
}
