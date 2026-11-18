import { expect, test } from 'claude-code/testing'

import { NO_AUTH, NO_GH, close, comment, create, createPr, edit, editComment, ensureLabels, list, me, read, setBody, setTitle, checks, mergePr, watchChecks } from './tracker'
import type { Issue, Run } from './tracker'
import { api, restGithub } from './fixtures/github'
import type { RestState } from './fixtures/github'

type Answer = { exitCode?: number; stdout?: string; stderr?: string } | null
type Answers = Record<string, Answer | (() => Answer)>

const R = 'repos/{owner}/{repo}'

/**
 * A fake `run` that answers by method and endpoint (`GET repos/{owner}/{repo}/issues/12`, the query included) and
 * records every argv it is given. An answer may be a function, asked at each call.
 */
const fake = (answers: Answers) => {
  const calls: string[][] = []
  const run: Run = async argv => {
    calls.push(argv)
    const key = argv[2] === '-X' ? `${argv[3]} ${argv[4]}` : `GET ${argv[2]}`
    const found = answers[key]
    const a = typeof found === 'function' ? found() : found
    if (a === null) return null
    if (a === undefined) throw new Error(`no answer for ${argv.join(' ')}`)
    return { exitCode: a.exitCode ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
  }
  return { run, calls }
}
const json = (value: unknown): Answer => ({ stdout: JSON.stringify(value) })
const http = (status: number, message: string, errors: unknown[] = []): Answer => ({ exitCode: 1, stdout: JSON.stringify({ message, errors }), stderr: `gh: ${message} (HTTP ${status})` })

/** The in-memory GitHub of the fixtures as a `run`, with every argv recorded. */
const github = (state: RestState) => {
  const calls: string[][] = []
  const answer = restGithub(state, Date.parse('2026-11-05T10:00:00Z'))
  const run: Run = async argv => {
    calls.push(argv)
    return answer(argv)
  }
  return { run, calls }
}
const issueOf = (number: number, extra: Partial<Issue> = {}): Issue => ({ number, title: `Issue ${number}`, body: 'text', author: 'ann', labels: ['pipeline'], assignees: [], state: 'open', url: `https://github.com/o/r/issues/${number}`, createdAt: '2026-11-01T10:00:00Z', comments: [], ...extra })

const ISSUE = { number: 12, title: 'CSV export', body: 'We need it', user: { login: 'ann' }, labels: [{ name: 'pipeline' }], assignees: [{ login: 'cy' }], state: 'open', html_url: 'https://github.com/o/r/issues/12', created_at: '2026-11-01T10:00:00Z', comments: 1 }
const COMMENT = { id: 900, user: { login: 'bob' }, author_association: 'MEMBER', body: 'hi', created_at: '2026-11-02T10:00:00Z', html_url: 'https://github.com/o/r/issues/12#issuecomment-900' }
const LIST = `${R}/issues?labels=pipeline&state=open&per_page=100&page=1`

test('list asks for the labelled open issues and maps them, oldest first', async () => {
  const { run, calls } = fake({
    [`GET ${LIST}`]: json([{ ...ISSUE, number: 14, comments: 0 }, ISSUE]),
    [`GET ${R}/issues/12/comments?per_page=100&page=1`]: json([COMMENT]),
  })
  const r = await list(run, 'pipeline')
  expect(calls).toEqual([['gh', 'api', LIST], ['gh', 'api', `${R}/issues/12/comments?per_page=100&page=1`]])
  expect(r.ok && r.value.map(i => i.number)).toEqual([12, 14])
  expect(r.ok && r.value[0]).toEqual({ number: 12, title: 'CSV export', body: 'We need it', author: 'ann', labels: ['pipeline'], assignees: ['cy'], state: 'open', url: 'https://github.com/o/r/issues/12', createdAt: '2026-11-01T10:00:00Z', comments: [{ id: '900', author: 'bob', association: 'MEMBER', body: 'hi', at: '2026-11-02T10:00:00Z' }] })
  expect(r.ok && r.value[1]!.comments).toEqual([])
})

test('list drops the pull requests the REST list answers with the issues, and encodes the label', async () => {
  const at = `${R}/issues?labels=needs%20info&state=open&per_page=100&page=1`
  const { run, calls } = fake({ [`GET ${at}`]: json([{ ...ISSUE, number: 3, comments: 0 }, { ...ISSUE, number: 4, comments: 2, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/4' } }]) })
  const r = await list(run, 'needs info')
  expect(r.ok && r.value.map(i => i.number)).toEqual([3])
  // Nor are the pull request's comments asked for.
  expect(calls.length).toBe(1)
})

test('list fetches comments only for the issues that have some, eight at a time', async () => {
  const issues = Array.from({ length: 20 }, (_, k) => issueOf(k + 1, k % 2 === 0 ? { comments: [{ id: String(500 + k), author: 'bob', association: 'NONE', body: `c${k + 1}`, at: 'x' }] } : {}))
  const answer = restGithub({ me: 'ann', issues }, 0)
  const calls: string[][] = []
  let open = 0
  let most = 0
  const run: Run = async argv => {
    calls.push(argv)
    open += 1
    most = Math.max(most, open)
    await Promise.resolve()
    open -= 1
    return answer(argv)
  }
  const r = await list(run, 'pipeline')
  const asked = calls.filter(c => c[2]!.includes('/comments')).map(c => Number(/issues\/(\d+)\/comments/.exec(c[2]!)![1]))
  expect(asked.sort((a, b) => a - b)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19])
  expect(most).toBe(8)
  expect(r.ok && r.value.map(i => i.comments.map(c => c.body))).toEqual(issues.map(i => i.comments.map(c => c.body)))
})

test('list and the comments page past a hundred, until a page comes back short', async () => {
  const comments = Array.from({ length: 205 }, (_, k) => ({ id: String(1000 + k), author: 'bob', association: 'NONE', body: `c${k}`, at: 'x' }))
  const issues = Array.from({ length: 150 }, (_, k) => issueOf(150 - k, k === 0 ? { comments } : {}))
  const { run, calls } = github({ me: 'ann', issues })
  const r = await list(run, 'pipeline')
  expect(r.ok && r.value.length).toBe(150)
  expect(r.ok && r.value.map(i => i.number)).toEqual(Array.from({ length: 150 }, (_, k) => k + 1))
  expect(r.ok && r.value[149]!.comments.length).toBe(205)
  expect(r.ok && r.value[149]!.comments[204]).toMatchObject({ id: '1204', body: 'c204' })
  expect(calls.map(c => c[2]!.slice(R.length + 1))).toEqual([
    'issues?labels=pipeline&state=open&per_page=100&page=1',
    'issues?labels=pipeline&state=open&per_page=100&page=2',
    'issues/150/comments?per_page=100&page=1',
    'issues/150/comments?per_page=100&page=2',
    'issues/150/comments?per_page=100&page=3',
  ])
  // Exactly a hundred: one more page is asked for, and it is empty.
  const exact = github({ me: 'ann', issues: issues.slice(1, 101) })
  const hundred = await list(exact.run, 'pipeline')
  expect(hundred.ok && hundred.value.length).toBe(100)
  expect(exact.calls.length).toBe(2)
})

test('read asks for one issue and then its comments', async () => {
  const { run, calls } = fake({ [`GET ${R}/issues/12`]: json(ISSUE), [`GET ${R}/issues/12/comments?per_page=100&page=1`]: json([COMMENT]) })
  const r = await read(run, 12)
  expect(calls).toEqual([['gh', 'api', `${R}/issues/12`], ['gh', 'api', `${R}/issues/12/comments?per_page=100&page=1`]])
  expect(r.ok && r.value.comments[0]).toEqual({ id: '900', author: 'bob', association: 'MEMBER', body: 'hi', at: '2026-11-02T10:00:00Z' })
})

test('create and comment read the number and the id from the JSON gh prints', async () => {
  const { run, calls } = fake({ [`POST ${R}/issues`]: json({ number: 31, html_url: 'https://github.com/o/r/issues/31' }), [`POST ${R}/issues/31/comments`]: json({ id: 77, html_url: 'https://github.com/o/r/issues/31#issuecomment-77' }) })
  expect(await create(run, { title: 'T', body: 'B', labels: ['pipeline', 'bug'] })).toEqual({ ok: true, value: 31 })
  expect(calls[0]).toEqual(['gh', 'api', '-X', 'POST', `${R}/issues`, '-f', 'title=T', '-f', 'body=B', '-f', 'labels[]=pipeline', '-f', 'labels[]=bug'])
  expect(await comment(run, 31, 'text')).toEqual({ ok: true, value: '77' })
  expect(calls[1]).toEqual(['gh', 'api', '-X', 'POST', `${R}/issues/31/comments`, '-f', 'body=text'])
})

test('edit makes only the calls it was given, and none means no call', async () => {
  const state: RestState = { me: 'me', issues: [issueOf(12, { labels: ['pipeline', 'pipeline:blocked', 'pipeline:needs-info'], assignees: ['zoe'] })] }
  const { run, calls } = github(state)
  expect(await edit(run, 12, { add: ['pipeline:building', 'x'], remove: ['pipeline:blocked', 'pipeline:needs-info'], assign: 'me' })).toEqual({ ok: true, value: true })
  expect(calls).toEqual([
    api('POST', 'issues/12/labels', 'labels[]=pipeline:building', 'labels[]=x'),
    api('DELETE', 'issues/12/labels/pipeline%3Ablocked'),
    api('DELETE', 'issues/12/labels/pipeline%3Aneeds-info'),
    api('POST', 'issues/12/assignees', 'assignees[]=me'),
  ])
  expect(state.issues[0]).toMatchObject({ labels: ['pipeline', 'pipeline:building', 'x'], assignees: ['zoe', 'me'] })
  expect(await edit(run, 12, {})).toEqual({ ok: true, value: true })
  expect(await edit(run, 12, { add: [], remove: [] })).toEqual({ ok: true, value: true })
  expect(calls.length).toBe(4)
  await edit(run, 12, { unassign: 'me' })
  expect(calls[4]).toEqual(api('DELETE', 'issues/12/assignees', 'assignees[]=me'))
  expect(state.issues[0]!.assignees).toEqual(['zoe'])
})

test('edit: a 404 on removing a label is success, and the first real failure stops it', async () => {
  const state: RestState = { me: 'me', issues: [issueOf(12, { labels: ['pipeline', 'b'] })] }
  const gone = github(state)
  // `a` is not on the issue: GitHub answers 404, and `b` is still removed after it.
  expect(await edit(gone.run, 12, { remove: ['a', 'b'], assign: 'me' })).toEqual({ ok: true, value: true })
  expect(gone.calls.length).toBe(3)
  expect(state.issues[0]).toMatchObject({ labels: ['pipeline'], assignees: ['me'] })
  const broken = fake({ [`POST ${R}/issues/12/labels`]: json([]), [`DELETE ${R}/issues/12/labels/a`]: { exitCode: 1, stderr: 'gh: Server Error (HTTP 500)' } })
  expect(await edit(broken.run, 12, { add: ['x'], remove: ['a', 'b'], assign: 'me' })).toEqual({ ok: false, error: 'gh: gh: Server Error (HTTP 500)' })
  expect(broken.calls.length).toBe(2)
  const first = fake({ [`POST ${R}/issues/12/labels`]: http(403, 'Forbidden') })
  expect((await edit(first.run, 12, { add: ['x'], remove: ['a'] })).ok).toBe(false)
  expect(first.calls.length).toBe(1)
})

test('setTitle and setBody replace the title and the body of an issue', async () => {
  const { run, calls } = fake({ [`PATCH ${R}/issues/12`]: json({ number: 12 }) })
  expect(await setBody(run, 12, 'new body')).toEqual({ ok: true, value: true })
  expect(calls[0]).toEqual(['gh', 'api', '-X', 'PATCH', `${R}/issues/12`, '-f', 'body=new body'])
  expect(await setTitle(run, 12, 'New title')).toEqual({ ok: true, value: true })
  expect(calls[1]).toEqual(['gh', 'api', '-X', 'PATCH', `${R}/issues/12`, '-f', 'title=New title'])
})

test('editComment patches by id; ensureLabels creates each, and one that exists is success', async () => {
  const { run, calls } = fake({ [`PATCH ${R}/issues/comments/77`]: json({}), [`POST ${R}/labels`]: json({}) })
  await editComment(run, '77', 'new')
  expect(calls[0]).toEqual(['gh', 'api', '-X', 'PATCH', `${R}/issues/comments/77`, '-f', 'body=new'])
  expect(await ensureLabels(run, ['a', 'b'])).toEqual({ ok: true, value: true })
  expect(calls.slice(1)).toEqual([['gh', 'api', '-X', 'POST', `${R}/labels`, '-f', 'name=a', '-f', 'color=6f42c1'], ['gh', 'api', '-X', 'POST', `${R}/labels`, '-f', 'name=b', '-f', 'color=6f42c1']])
  // `a` exists: 422 already_exists, and `c` is still created.
  const state: RestState = { me: 'me', issues: [], labels: ['a'] }
  const there = github(state)
  expect(await ensureLabels(there.run, ['a', 'c'])).toEqual({ ok: true, value: true })
  expect(state.labels).toEqual(['a', 'c'])
  expect(there.calls.length).toBe(2)
  // Anything else stops it at that label.
  const denied = fake({ [`POST ${R}/labels`]: http(403, 'Resource not accessible by integration') })
  expect(await ensureLabels(denied.run, ['a', 'b'])).toEqual({ ok: false, error: 'gh: gh: Resource not accessible by integration (HTTP 403)' })
  expect(denied.calls.length).toBe(1)
})

test('me and close', async () => {
  const { run, calls } = fake({ 'GET user': json({ login: 'ann', id: 1 }), [`PATCH ${R}/issues/12`]: json({ number: 12, state: 'closed' }) })
  expect(await me(run)).toEqual({ ok: true, value: 'ann' })
  expect(calls[0]).toEqual(['gh', 'api', 'user'])
  expect(await close(run, 12)).toEqual({ ok: true, value: true })
  expect(calls[1]).toEqual(['gh', 'api', '-X', 'PATCH', `${R}/issues/12`, '-f', 'state=closed'])
})

test('no call uses --jq, --paginate, --slurp or a typed field', async () => {
  const { run, calls } = github({ me: 'me', issues: [issueOf(1, { comments: [{ id: '5', author: 'a', association: 'NONE', body: 'b', at: 'x' }] })], checks: [{ name: 'ci', bucket: 'pass' }] })
  await me(run)
  await list(run, 'pipeline')
  await read(run, 1)
  await create(run, { title: 'T', body: 'B', labels: ['pipeline'] })
  await comment(run, 1, 'c')
  await editComment(run, '5', 'd')
  await edit(run, 1, { add: ['a'], remove: ['a'], assign: 'me', unassign: 'me' })
  await setTitle(run, 1, 't')
  await setBody(run, 1, 'b')
  await ensureLabels(run, ['a'])
  await createPr(run, { base: 'main', head: 'feat/1', title: 'T', body: 'B' })
  await checks(run, 31)
  await mergePr(run, 31, 'merge')
  await close(run, 1)
  expect(calls.length).toBeGreaterThan(18)
  for (const c of calls) {
    expect(c.slice(0, 2)).toEqual(['gh', 'api'])
    expect(c.some(a => ['--jq', '-q', '--paginate', '--slurp', '-F', '--field', 'graphql'].includes(a))).toBe(false)
  }
})

test('failures: no gh, not logged in, another error, bad output', async () => {
  expect(await list(fake({ [`GET ${LIST}`]: null }).run, 'pipeline')).toEqual({ ok: false, error: NO_GH })
  expect(await list(fake({ [`GET ${LIST}`]: { exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' } }).run, 'pipeline')).toEqual({ ok: false, error: NO_AUTH })
  expect(await list(fake({ [`GET ${LIST}`]: { exitCode: 1, stderr: 'could not resolve host\nmore' } }).run, 'pipeline')).toEqual({ ok: false, error: 'gh: could not resolve host' })
  expect(await list(fake({ [`GET ${LIST}`]: { stdout: 'not json' } }).run, 'pipeline')).toEqual({ ok: false, error: `gh: unexpected output from GET ${R}/issues` })
  expect(await list(fake({ [`GET ${LIST}`]: json([{ title: 'no number' }]) }).run, 'pipeline')).toEqual({ ok: false, error: `gh: unexpected output from GET ${R}/issues` })
  // The comments of one issue failing fails the list.
  expect(await list(fake({ [`GET ${LIST}`]: json([ISSUE]), [`GET ${R}/issues/12/comments?per_page=100&page=1`]: { exitCode: 1, stderr: 'could not resolve host' } }).run, 'pipeline')).toEqual({ ok: false, error: 'gh: could not resolve host' })
  expect(await create(fake({ [`POST ${R}/issues`]: { stdout: 'nothing here' } }).run, { title: 'T', body: 'B', labels: [] })).toEqual({ ok: false, error: `gh: unexpected output from POST ${R}/issues` })
  expect(await comment(fake({ [`POST ${R}/issues/3/comments`]: json({}) }).run, 3, 'x')).toEqual({ ok: false, error: `gh: unexpected output from POST ${R}/issues/3/comments` })
  expect(await me(fake({ 'GET user': null }).run)).toEqual({ ok: false, error: NO_GH })
  expect(await me(fake({ 'GET user': json({}) }).run)).toEqual({ ok: false, error: 'gh: unexpected output from GET user' })
  expect(await read(fake({ [`GET ${R}/issues/9`]: http(404, 'Not Found') }).run, 9)).toEqual({ ok: false, error: 'gh: gh: Not Found (HTTP 404)' })
  expect(await close(fake({ [`PATCH ${R}/issues/9`]: { exitCode: 1, stderr: 'error: authentication required' } }).run, 9)).toEqual({ ok: false, error: NO_AUTH })
})

test('an issue with no author, a null body and no comments maps to empty values', async () => {
  const { run, calls } = fake({ [`GET ${R}/issues/5`]: json({ number: 5, title: 'T', body: null, user: null, labels: [], assignees: [], state: 'closed', html_url: 'u', created_at: 'c', comments: 0 }) })
  expect(await read(run, 5)).toEqual({ ok: true, value: { number: 5, title: 'T', body: '', author: '', labels: [], assignees: [], state: 'closed', url: 'u', createdAt: 'c', comments: [] } })
  expect(calls.length).toBe(1)
})

const SHA = 'abc123'
type CheckRun = { name: string; status: string; conclusion: string | null }
type Status = { context: string; state: string }
const checkAnswers = (runs: CheckRun[], statuses: Status[]): Answers => ({
  [`GET ${R}/pulls/96`]: json({ number: 96, head: { sha: SHA } }),
  [`GET ${R}/commits/${SHA}/check-runs?per_page=100`]: json({ total_count: runs.length, check_runs: runs }),
  [`GET ${R}/commits/${SHA}/status`]: json({ state: 'pending', statuses }),
})
const done = (name: string, conclusion: string): CheckRun => ({ name, status: 'completed', conclusion })

test('checks reads the head commit, then its check runs and its statuses', async () => {
  const { run, calls } = fake(checkAnswers([done('test', 'success')], []))
  expect(await checks(run, 96)).toEqual({ ok: true, value: { state: 'green', failing: [] } })
  expect(calls).toEqual([['gh', 'api', `${R}/pulls/96`], ['gh', 'api', `${R}/commits/${SHA}/check-runs?per_page=100`], ['gh', 'api', `${R}/commits/${SHA}/status`]])
})

test('checks: both sources count, for none, pending, red and green', async () => {
  const of = (runs: CheckRun[], statuses: Status[]) => checks(fake(checkAnswers(runs, statuses)).run, 96)
  const state = (s: string, failing: string[] = []) => ({ ok: true, value: { state: s, failing } })
  // none: neither source reports anything.
  expect(await of([], [])).toEqual(state('none'))
  // pending: a check run not completed, or a pending status, with the other source through.
  expect(await of([done('test', 'success'), { name: 'lint', status: 'in_progress', conclusion: null }], [])).toEqual(state('pending'))
  expect(await of([{ name: 'lint', status: 'queued', conclusion: null }], [{ context: 'ci/old', state: 'success' }])).toEqual(state('pending'))
  expect(await of([done('test', 'success')], [{ context: 'ci/old', state: 'pending' }])).toEqual(state('pending'))
  expect(await of([], [{ context: 'ci/old', state: 'pending' }])).toEqual(state('pending'))
  // red: every failing conclusion and state, named, check runs first; red wins over pending.
  expect(await of([done('test', 'failure'), done('lint', 'success'), done('e2e', 'cancelled'), done('slow', 'timed_out'), done('gate', 'action_required'), done('boot', 'startup_failure'), { name: 'late', status: 'in_progress', conclusion: null }], [{ context: 'ci/old', state: 'error' }, { context: 'ci/older', state: 'failure' }, { context: 'ci/fine', state: 'success' }])).toEqual(
    state('red', ['test', 'e2e', 'slow', 'gate', 'boot', 'ci/old', 'ci/older']),
  )
  // A failing commit status with passing check runs is red.
  expect(await of([done('test', 'success'), done('lint', 'success')], [{ context: 'ci/old', state: 'failure' }])).toEqual(state('red', ['ci/old']))
  expect(await of([done('test', 'failure')], [{ context: 'ci/old', state: 'success' }])).toEqual(state('red', ['test']))
  // green: success, neutral and skipped pass; either source alone is enough.
  expect(await of([done('test', 'success'), done('docs', 'skipped'), done('info', 'neutral')], [{ context: 'ci/old', state: 'success' }])).toEqual(state('green'))
  expect(await of([done('test', 'success')], [])).toEqual(state('green'))
  expect(await of([], [{ context: 'ci/old', state: 'success' }])).toEqual(state('green'))
})

test('checks failures: no gh, not logged in, an error from any of the three calls, bad output', async () => {
  const ok = checkAnswers([done('test', 'success')], [])
  expect(await checks(fake({ [`GET ${R}/pulls/96`]: null }).run, 96)).toEqual({ ok: false, error: NO_GH })
  expect(await checks(fake({ [`GET ${R}/pulls/96`]: { exitCode: 1, stderr: 'gh auth login' } }).run, 96)).toEqual({ ok: false, error: NO_AUTH })
  expect(await checks(fake({ [`GET ${R}/pulls/96`]: http(404, 'Not Found') }).run, 96)).toEqual({ ok: false, error: 'gh: gh: Not Found (HTTP 404)' })
  expect(await checks(fake({ [`GET ${R}/pulls/96`]: json({ number: 96 }) }).run, 96)).toEqual({ ok: false, error: `gh: unexpected output from GET ${R}/pulls/96` })
  expect(await checks(fake({ ...ok, [`GET ${R}/commits/${SHA}/check-runs?per_page=100`]: { exitCode: 1, stderr: 'boom' } }).run, 96)).toEqual({ ok: false, error: 'gh: boom' })
  expect(await checks(fake({ ...ok, [`GET ${R}/commits/${SHA}/check-runs?per_page=100`]: json({}) }).run, 96)).toEqual({ ok: false, error: `gh: unexpected output from GET ${R}/commits/${SHA}/check-runs` })
  expect(await checks(fake({ ...ok, [`GET ${R}/commits/${SHA}/status`]: { exitCode: 1, stderr: 'boom' } }).run, 96)).toEqual({ ok: false, error: 'gh: boom' })
  expect(await checks(fake({ ...ok, [`GET ${R}/commits/${SHA}/status`]: json([]) }).run, 96)).toEqual({ ok: false, error: `gh: unexpected output from GET ${R}/commits/${SHA}/status` })
})

/** A `run` whose checks follow the script, one entry per poll (the last one repeats), and the waits it was asked for. */
const polled = (script: CheckRun[][]) => {
  let poll = -1
  const waits: number[] = []
  const { run, calls } = fake({
    [`GET ${R}/pulls/96`]: () => {
      poll += 1
      return json({ number: 96, head: { sha: SHA } })
    },
    [`GET ${R}/commits/${SHA}/check-runs?per_page=100`]: () => json({ check_runs: script[Math.min(poll, script.length - 1)] }),
    [`GET ${R}/commits/${SHA}/status`]: json({ statuses: [] }),
  })
  const wait = async (ms: number) => void waits.push(ms)
  return { run, calls, waits, wait, polls: () => poll + 1 }
}
const running: CheckRun = { name: 'test', status: 'in_progress', conclusion: null }

test('watchChecks waits through none and then pending to green, 5 s and 15 s apart', async () => {
  const w = polled([[], [], [running], [running], [done('test', 'success')]])
  expect(await watchChecks(w.run, 96, w.wait)).toEqual({ ok: true, value: { state: 'green', failing: [] } })
  expect(w.waits).toEqual([5000, 5000, 15_000, 15_000])
  expect(w.polls()).toBe(5)
})

test('watchChecks answers green or red at once, and red as soon as a check fails', async () => {
  const green = polled([[done('test', 'success')]])
  expect(await watchChecks(green.run, 96, green.wait)).toEqual({ ok: true, value: { state: 'green', failing: [] } })
  expect(green.waits).toEqual([])
  const red = polled([[running], [done('test', 'failure')]])
  expect(await watchChecks(red.run, 96, red.wait)).toEqual({ ok: true, value: { state: 'red', failing: ['test'] } })
  expect(red.waits).toEqual([15_000])
})

test('watchChecks answers none only after six more polls, and the last pending after 240', async () => {
  const none = polled([[]])
  expect(await watchChecks(none.run, 96, none.wait)).toEqual({ ok: true, value: { state: 'none', failing: [] } })
  expect(none.waits).toEqual([5000, 5000, 5000, 5000, 5000, 5000])
  expect(none.polls()).toBe(7)
  const slow = polled([[running]])
  expect(await watchChecks(slow.run, 96, slow.wait)).toEqual({ ok: true, value: { state: 'pending', failing: [] } })
  expect(slow.polls()).toBe(240)
  expect(slow.waits.length).toBe(239)
  expect(slow.waits.every(ms => ms === 15_000)).toBe(true)
})

test('watchChecks stops at an error without waiting again', async () => {
  const waits: number[] = []
  const wait = async (ms: number) => void waits.push(ms)
  expect(await watchChecks(fake({ [`GET ${R}/pulls/96`]: null }).run, 96, wait)).toEqual({ ok: false, error: NO_GH })
  expect(await watchChecks(fake({ [`GET ${R}/pulls/96`]: { exitCode: 1, stderr: 'not logged in' } }).run, 96, wait)).toEqual({ ok: false, error: NO_AUTH })
  expect(waits).toEqual([])
})

test('createPr opens the pull request and answers its number', async () => {
  const { run, calls } = fake({ [`POST ${R}/pulls`]: json({ number: 31, html_url: 'https://github.com/o/r/pull/31' }) })
  expect(await createPr(run, { base: 'main', head: 'feat/75', title: 'T', body: 'B' })).toEqual({ ok: true, value: 31 })
  expect(calls).toEqual([['gh', 'api', '-X', 'POST', `${R}/pulls`, '-f', 'title=T', '-f', 'head=feat/75', '-f', 'base=main', '-f', 'body=B']])
  expect(await createPr(fake({ [`POST ${R}/pulls`]: json({}) }).run, { base: 'main', head: 'h', title: 'T', body: 'B' })).toEqual({ ok: false, error: `gh: unexpected output from POST ${R}/pulls` })
  expect(await createPr(fake({ [`POST ${R}/pulls`]: http(422, 'Validation Failed', [{ message: 'No commits between main and feat/75' }]) }).run, { base: 'main', head: 'feat/75', title: 'T', body: 'B' })).toEqual({ ok: false, error: 'gh: gh: Validation Failed (HTTP 422)' })
})

test('createPr answers the number of the pull request that already exists for the head', async () => {
  const exists: Answer = { exitCode: 1, stdout: JSON.stringify({ message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for o:feat/75.' }] }), stderr: 'gh: Validation Failed (HTTP 422)\nA pull request already exists for o:feat/75.' }
  const open = `${R}/pulls?head={owner}:feat%2F75&state=open&per_page=1`
  const { run, calls } = fake({ [`POST ${R}/pulls`]: exists, [`GET ${open}`]: json([{ number: 44, head: { ref: 'feat/75' } }]) })
  expect(await createPr(run, { base: 'main', head: 'feat/75', title: 'T', body: 'B' })).toEqual({ ok: true, value: 44 })
  expect(calls[1]).toEqual(['gh', 'api', open])
  // The message in the response body alone is enough; when the search finds nothing, the first refusal is the answer.
  const quiet = fake({ [`POST ${R}/pulls`]: { ...exists, stderr: 'gh: Validation Failed (HTTP 422)' }, [`GET ${open}`]: json([]) })
  expect(await createPr(quiet.run, { base: 'main', head: 'feat/75', title: 'T', body: 'B' })).toEqual({ ok: false, error: 'gh: gh: Validation Failed (HTTP 422)' })
  expect(quiet.calls.length).toBe(2)
})

test('mergePr merges with the method and never asks for auto-merge', async () => {
  const { run, calls } = fake({ [`PUT ${R}/pulls/96/merge`]: json({ merged: true }) })
  expect(await mergePr(run, 96, 'merge')).toEqual({ ok: true, value: true })
  expect(await mergePr(run, 96, 'squash')).toEqual({ ok: true, value: true })
  expect(calls).toEqual([['gh', 'api', '-X', 'PUT', `${R}/pulls/96/merge`, '-f', 'merge_method=merge'], ['gh', 'api', '-X', 'PUT', `${R}/pulls/96/merge`, '-f', 'merge_method=squash']])
  expect(await mergePr(fake({ [`PUT ${R}/pulls/96/merge`]: http(405, 'Pull Request is not mergeable') }).run, 96, 'merge')).toEqual({ ok: false, error: 'gh: gh: Pull Request is not mergeable (HTTP 405)' })
})

test('watchChecks with CI expected waits five minutes for a first check: one that appears after 40 s is seen, and none at all is still none', async () => {
  // As in the live run: nothing for eight polls (40 s), then the check, already failed.
  const late = polled([[], [], [], [], [], [], [], [], [done('test', 'failure')]])
  expect(await watchChecks(late.run, 96, late.wait, true)).toEqual({ ok: true, value: { state: 'red', failing: ['test'] } })
  expect(late.waits.length).toBe(8)
  // Without the expectation the same pull request reads as having no CI after 30 s.
  const early = polled([[], [], [], [], [], [], [], [], [done('test', 'failure')]])
  expect((await watchChecks(early.run, 96, early.wait)).ok && (await watchChecks(early.run, 96, early.wait))).toBeTruthy()
  const never = polled([[]])
  expect(await watchChecks(never.run, 96, never.wait, true)).toEqual({ ok: true, value: { state: 'none', failing: [] } })
  expect(never.waits.length).toBe(60)
})
