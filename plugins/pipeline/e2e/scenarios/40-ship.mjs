import { existsSync } from 'node:fs'

import { TASK, commitIn, expect, expectMatch, issue, pull, setConfig, shoutChange, tool, worktreeOf } from '../lib.mjs'

export default {
  name: 'ship',
  tier: 'tool',
  checks: 'mode direct without a model building: begin makes the worktree, ship runs the gate, opens the pull request, waits for CI, merges and closes',
  async run() {
    setConfig({ mode: 'direct' })
    const id = expectMatch(tool({ action: 'add', item: { title: TASK.title }, text: TASK.spec }), /^added (\d+)/, 'add did not answer the new issue')[1]
    expectMatch(tool({ action: 'begin', item: id }), new RegExp(`^${id} · building · branch feat/${id}`), 'begin did not claim the item')
    const wt = worktreeOf(id)
    expect(existsSync(wt), `begin made no worktree at ${wt}`)

    // The building, done here in place of a model: one commit on the item's branch.
    commitIn(wt, shoutChange(), `Add shout helper (#${id})`)

    const shipped = tool({ action: 'ship', item: id })
    expect(!/gate could not be run|gate red/.test(shipped), `the gate did not run green: "${shipped.split('\n')[0]}"`)
    expect(shipped.includes(`${id} merged`), `ship did not end with the item merged: "${shipped.split('\n')[0]}"`)
    const pr = expectMatch(shipped, /PR #(\d+)/, 'ship did not name the pull request')[1]
    expect(pull(pr).state === 'MERGED', `PR ${pr} is not merged`)
    expect(issue(id).state === 'CLOSED', `issue ${id} is still open`)
    expect(!existsSync(wt), `the worktree ${wt} was not removed`)
  },
}
