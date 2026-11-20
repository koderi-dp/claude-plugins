import { MARK, expect, expectMatch, issue, tool } from '../lib.mjs'

export default {
  name: 'remove',
  tier: 'tool',
  checks: 'an issue is closed as not planned with the reason written on it; without a reason it is refused',
  async run() {
    const id = expectMatch(tool({ action: 'add', item: { title: `${MARK} Dark mode for the helpers` } }), /^added (\d+)/, 'add did not answer the new issue')[1]
    expectMatch(tool({ action: 'remove', id }), /^refused: .*needs "text"/, 'remove without a reason was not refused')
    expect(issue(id).state === 'OPEN', `issue ${id} was closed without a reason`)

    const reason = 'helpers have no screen, so there is nothing to theme'
    expectMatch(tool({ action: 'remove', id, text: reason }), new RegExp(`^${id} closed as not planned`), 'remove did not close the issue')
    const closed = issue(id)
    expect(closed.state === 'CLOSED' && closed.stateReason === 'NOT_PLANNED', `issue ${id} is ${closed.state} / ${closed.stateReason}`)
    expect(closed.comments.some(c => c.body.includes('<!-- pipeline:declined -->') && c.body.includes(reason)), `issue ${id} does not carry the reason`)
  },
}
