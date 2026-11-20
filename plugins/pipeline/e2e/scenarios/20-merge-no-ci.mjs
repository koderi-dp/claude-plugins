import { DOCS, docsChange, expect, expectMatch, issue, openPr, pull, tool } from '../lib.mjs'

export default {
  name: 'merge-no-ci',
  tier: 'tool',
  checks: 'a docs-only pull request, which the CI workflow ignores, is merged after the short wait and not refused',
  async run() {
    const pr = openPr({ branch: 'e2e/docs', files: docsChange(), title: DOCS.title, body: DOCS.body })
    const id = expectMatch(tool({ action: 'adopt', pr: `#${pr}` }), /^adopted PR #\d+ as (\d+) · review/, 'adopt did not answer the adopted item')[1]

    const merged = tool({ action: 'merge', item: id })
    expect(merged.includes(`${id} merged`), `the pull request was not merged: "${merged.split('\n')[0]}"`)
    expect(merged.includes('CI none (no workflow ran for this commit)'), `merge did not say that no workflow ran: "${merged.split('\n')[0]}"`)
    expect(pull(pr).state === 'MERGED', `PR ${pr} is not merged`)
    expect(issue(id).state === 'CLOSED', `issue ${id} is still open`)
  },
}
