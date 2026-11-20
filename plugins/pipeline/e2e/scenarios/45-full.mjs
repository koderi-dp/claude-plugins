import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { TASK, commitIn, expect, expectMatch, issue, pull, shoutChange, tool, worktreeOf } from '../lib.mjs'

const plan = id => `# ${id}: ${TASK.title}

## Constraints
Only the two files of task 1 change. The existing helpers and their tests stay as they are.

## Parked
nothing

### Task 1: The shout helper
- Files: src/text.js, src/text.test.js
- Pinned: shout(s): string
- Needs: none
- Check: node --test
- Commit: Add shout helper
- Focus: a value that is not a string

Write the test first: in src/text.test.js, \`shout('hi')\` is \`'HI!'\`. Then export \`shout(s)\` from src/text.js: \`String(s).toUpperCase() + '!'\`. Done when node --test passes.
`

export default {
  name: 'full',
  tier: 'tool',
  checks: 'mode full, the default, without a model building: begin, plan, the implementer brief with the worktree in it, accept, then one ship with the final verdict: the gate, the pull request, CI, merge and close',
  async run() {
    // No mode is set here or in the sandbox: this is the plugin's default.
    const id = expectMatch(tool({ action: 'add', item: { title: TASK.title }, text: TASK.spec }), /^added (\d+)/, 'add did not answer the new issue')[1]
    expectMatch(tool({ action: 'begin', item: id }), new RegExp(`^${id} · planning · branch feat/${id}`), 'begin did not leave the item in planning: is full still the default?')
    const wt = worktreeOf(id)
    expect(existsSync(wt), `begin made no worktree at ${wt}`)

    // The lead's part: the plan, where the tool looks for it with the issues as the queue.
    const planFile = join(wt, '.pipeline', id, 'plan.md')
    mkdirSync(dirname(planFile), { recursive: true })
    writeFileSync(planFile, plan(id))
    const planned = tool({ action: 'plan', item: id })
    expectMatch(planned, new RegExp(`^${id} · building · 1 task`), 'plan did not accept the plan')
    expect(/pipeline:implementer/.test(planned), `plan did not answer the implementer call: "${planned.split('\n')[0]}"`)
    const brief = join(wt, '.pipeline', id, 'task-1-brief.md')
    expect(existsSync(brief), 'the implementer brief of task 1 was not written')
    expect(readFileSync(brief, 'utf8').includes(wt.replace(/\\/g, '/')), 'the brief does not name the worktree the implementer must work in')

    // The implementer's part: one commit on the item's branch.
    commitIn(wt, shoutChange(), 'Add shout helper')
    const accepted = tool({ action: 'accept', item: id, task: 1, tokens: 1000, minutes: 1, verdict: 'checked by the e2e script' })
    expectMatch(accepted, new RegExp(`^${id} · task 1 accepted · 1/1`), 'accept did not accept the task')

    // The final reviewer's part is the verdict; one ship call then runs the gate, opens the pull request, waits for
    // CI, merges and closes.
    const shipped = tool({ action: 'ship', item: id, verdict: 'approved', tokens: 1000 })
    expect(shipped.includes(`${id} merged`) && shipped.includes('1 task') && shipped.includes('CI green'), `ship did not end with a green merge of one task: "${shipped.split('\n')[0]}"`)
    const pr = expectMatch(shipped, /PR #(\d+)/, 'ship did not name the pull request')[1]
    expectMatch(tool({ action: 'close', item: id }), new RegExp(`^${id} is already closed`), 'a close after the merge was not answered plainly')
    expect(pull(pr).state === 'MERGED', `PR ${pr} is not merged`)
    expect(issue(id).state === 'CLOSED', `issue ${id} is still open`)
    expect(!existsSync(wt), `the worktree ${wt} was not removed`)
  },
}
