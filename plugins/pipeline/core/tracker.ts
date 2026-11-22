// GitHub issues and pull requests over the REST API, through `gh api`. The only module that builds a gh argument
// list: the caller hands in `run`, which runs an argv without a shell and answers null when gh cannot be started.
// REST only: gh's own commands (`gh issue`, `gh pr`, `gh label`) use GraphQL, which Claude cloud sessions refuse.
// No --jq and no --paginate: gh's whole JSON is parsed here and pages are asked for one by one. Pure apart from
// `run`: no state, no engine.

export type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string } | null>
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
export type IssueComment = { id: string; author: string; association: string; body: string; at: string }
export type Issue = { number: number; title: string; body: string; author: string; labels: string[]; assignees: string[]; state: 'open' | 'closed'; url: string; createdAt: string; comments: IssueComment[] }

export const SPEC_MARK = '<!-- pipeline:spec -->'
export const QUESTION_MARK = '<!-- pipeline:question -->'
export const DECLINED_MARK = '<!-- pipeline:declined -->'
export const NO_GH = 'gh is not installed or not on PATH: install the GitHub CLI, then run gh auth login'
export const NO_AUTH = 'gh is not logged in: run gh auth login'

const AUTH = /gh auth login|not logged in|authentication/i
const REPO = 'repos/{owner}/{repo}'
const PAGE = 100
const COMMENT_BATCH = 8

type Field = readonly [key: string, value: string]
type Called = { ok: true; value: string } | { ok: false; error: string; said: string }

/**
 * One REST call through `gh api` and its stdout, or the error the rules give for no gh, no login or a failure, with
 * what gh said (stderr and the response body) for the caller that treats one refusal as success. `{owner}/{repo}` in
 * the endpoint is literal: gh fills it from the checkout. Fields are raw strings (-f), sent as the JSON body.
 */
async function api(run: Run, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', endpoint: string, fields: Field[] = [], typed: Field[] = []): Promise<Called> {
  // `-f` sends text; `-F` sends a number or null as such, which a milestone needs.
  const r = await run(['gh', 'api', ...(method === 'GET' ? [] : ['-X', method]), endpoint, ...fields.flatMap(([k, v]) => ['-f', `${k}=${v}`]), ...typed.flatMap(([k, v]) => ['-F', `${k}=${v}`])])
  if (r === null) return { ok: false, error: NO_GH, said: '' }
  if (r.exitCode !== 0) {
    const said = `${r.stderr}\n${r.stdout}`
    if (AUTH.test(r.stderr)) return { ok: false, error: NO_AUTH, said }
    return { ok: false, error: `gh: ${r.stderr.split('\n')[0]!.trim()}`, said }
  }
  return { ok: true, value: r.stdout }
}

const fail = (r: { error: string }): { ok: false; error: string } => ({ ok: false, error: r.error })
const done = (r: Called): Result<true> => (r.ok ? { ok: true, value: true } : fail(r))
const unexpected = (method: string, endpoint: string): { ok: false; error: string } => ({ ok: false, error: `gh: unexpected output from ${method} ${endpoint.split('?')[0]}` })

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const login = (v: unknown): string => str(obj(v)['login'])
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const many = (key: string, values: string[]): Field[] => values.map(v => [`${key}[]`, v] as const)

/** One issue of the REST API in our shape, without its comments; null when it is not an object with a number. */
function toIssue(raw: unknown): Issue | null {
  const o = obj(raw)
  if (typeof o['number'] !== 'number') return null
  return {
    number: o['number'],
    title: str(o['title']),
    body: str(o['body']),
    author: login(o['user']),
    labels: arr(o['labels']).map(l => (typeof l === 'string' ? l : str(obj(l)['name']))).filter(Boolean),
    assignees: arr(o['assignees']).map(login).filter(Boolean),
    state: str(o['state']).toLowerCase() === 'closed' ? 'closed' : 'open',
    url: str(o['html_url']),
    createdAt: str(o['created_at']),
    comments: [],
  }
}

function toComment(raw: unknown): IssueComment {
  const m = obj(raw)
  return { id: typeof m['id'] === 'number' || typeof m['id'] === 'string' ? String(m['id']) : '', author: login(m['user']), association: str(m['author_association']), body: str(m['body']), at: str(m['created_at']) }
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Every entry of a list endpoint: page after page of a hundred until one comes back short. */
async function pages(run: Run, endpoint: string): Promise<Result<unknown[]>> {
  const all: unknown[] = []
  for (let page = 1; ; page++) {
    const r = await api(run, 'GET', `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=${PAGE}&page=${page}`)
    if (!r.ok) return fail(r)
    const raw = parse(r.value)
    if (!Array.isArray(raw)) return unexpected('GET', endpoint)
    all.push(...raw)
    if (raw.length < PAGE) return { ok: true, value: all }
  }
}

/** The comments of an issue, oldest first as GitHub lists them. */
async function commentsOf(run: Run, number: number): Promise<Result<IssueComment[]>> {
  const r = await pages(run, `${REPO}/issues/${number}/comments`)
  return r.ok ? { ok: true, value: r.value.map(toComment) } : r
}

const commentCount = (raw: unknown): number => {
  const n = obj(raw)['comments']
  return typeof n === 'number' ? n : 0
}

/** The login gh is signed in as. */
export async function me(run: Run): Promise<Result<string>> {
  const r = await api(run, 'GET', 'user')
  if (!r.ok) return fail(r)
  const name = login(parse(r.value))
  return name ? { ok: true, value: name } : unexpected('GET', 'user')
}

/**
 * The open issues with the label, in ascending number. The REST list also answers pull requests, which are dropped,
 * and carries no comments: those are asked for per issue that has some, eight issues at a time.
 */
export async function list(run: Run, label: string): Promise<Result<Issue[]>> {
  const endpoint = `${REPO}/issues?labels=${encodeURIComponent(label)}&state=open`
  const listed = await pages(run, endpoint)
  if (!listed.ok) return listed
  const rows = listed.value.filter(raw => !('pull_request' in obj(raw)))
  const issues: Issue[] = []
  const commented: Issue[] = []
  for (const raw of rows) {
    const issue = toIssue(raw)
    if (!issue) return unexpected('GET', endpoint)
    issues.push(issue)
    if (commentCount(raw) > 0) commented.push(issue)
  }
  for (let at = 0; at < commented.length; at += COMMENT_BATCH) {
    const batch = commented.slice(at, at + COMMENT_BATCH)
    const got = await Promise.all(batch.map(i => commentsOf(run, i.number)))
    for (const [k, r] of got.entries()) {
      if (!r.ok) return r
      batch[k]!.comments = r.value
    }
  }
  return { ok: true, value: issues.sort((a, b) => a.number - b.number) }
}

/** One issue by number, open or closed, with its comments. */
export async function read(run: Run, number: number): Promise<Result<Issue>> {
  const endpoint = `${REPO}/issues/${number}`
  const r = await api(run, 'GET', endpoint)
  if (!r.ok) return fail(r)
  const raw = parse(r.value)
  const issue = toIssue(raw)
  if (!issue) return unexpected('GET', endpoint)
  if (commentCount(raw) > 0) {
    const comments = await commentsOf(run, number)
    if (!comments.ok) return comments
    issue.comments = comments.value
  }
  return { ok: true, value: issue }
}

/** Opens an issue and answers its number. */
export async function create(run: Run, input: { title: string; body: string; labels: string[] }): Promise<Result<number>> {
  const endpoint = `${REPO}/issues`
  const r = await api(run, 'POST', endpoint, [['title', input.title], ['body', input.body], ...many('labels', input.labels)])
  if (!r.ok) return fail(r)
  const n = obj(parse(r.value))['number']
  return typeof n === 'number' ? { ok: true, value: n } : unexpected('POST', endpoint)
}

/** Comments on an issue and answers the new comment's id. */
export async function comment(run: Run, number: number, body: string): Promise<Result<string>> {
  const endpoint = `${REPO}/issues/${number}/comments`
  const r = await api(run, 'POST', endpoint, [['body', body]])
  if (!r.ok) return fail(r)
  const id = toComment(parse(r.value)).id
  return id ? { ok: true, value: id } : unexpected('POST', endpoint)
}

/** Replaces a comment's body. */
export async function editComment(run: Run, id: string, body: string): Promise<Result<true>> {
  return done(await api(run, 'PATCH', `${REPO}/issues/comments/${id}`, [['body', body]]))
}

/**
 * Adds and removes labels, adds an assignee and takes one off, each its own call and the first failure the answer; a
 * change that names nothing makes no call. A label that was not on the issue (404) is removed all the same.
 */
export async function edit(run: Run, number: number, change: { add?: string[]; remove?: string[]; assign?: string; unassign?: string }): Promise<Result<true>> {
  const issue = `${REPO}/issues/${number}`
  if (change.add?.length) {
    const r = await api(run, 'POST', `${issue}/labels`, many('labels', change.add))
    if (!r.ok) return fail(r)
  }
  for (const name of change.remove ?? []) {
    const r = await api(run, 'DELETE', `${issue}/labels/${encodeURIComponent(name)}`)
    if (!r.ok && !/HTTP 404|not found|does not exist/i.test(r.said)) return fail(r)
  }
  if (change.assign) {
    const r = await api(run, 'POST', `${issue}/assignees`, many('assignees', [change.assign]))
    if (!r.ok) return fail(r)
  }
  if (change.unassign) {
    const r = await api(run, 'DELETE', `${issue}/assignees`, many('assignees', [change.unassign]))
    if (!r.ok) return fail(r)
  }
  return { ok: true, value: true }
}

/** Replaces an issue's title. */
export async function setTitle(run: Run, number: number, title: string): Promise<Result<true>> {
  return done(await api(run, 'PATCH', `${REPO}/issues/${number}`, [['title', title]]))
}

/** Replaces an issue's body: a migrated item's dependencies, and `update` with a body or needs. */
export async function setBody(run: Run, number: number, body: string): Promise<Result<true>> {
  return done(await api(run, 'PATCH', `${REPO}/issues/${number}`, [['body', body]]))
}

export type Milestone = { number: number; title: string }

/** The repository's open milestones. */
export async function milestones(run: Run): Promise<Result<Milestone[]>> {
  const endpoint = `${REPO}/milestones?state=open&per_page=100`
  const r = await api(run, 'GET', endpoint)
  if (!r.ok) return fail(r)
  const rows = parse(r.value)
  if (!Array.isArray(rows)) return unexpected('GET', endpoint)
  return { ok: true, value: rows.map(obj).filter(o => typeof o['number'] === 'number').map(o => ({ number: o['number'] as number, title: str(o['title']) })) }
}

/** Puts an issue in a milestone, by the milestone's number, or takes it out of its milestone with null. */
export async function setMilestone(run: Run, number: number, milestone: number | null): Promise<Result<true>> {
  return done(await api(run, 'PATCH', `${REPO}/issues/${number}`, [], [['milestone', milestone === null ? 'null' : String(milestone)]]))
}

/** Closes an issue: as completed, or as not planned when `notPlanned` says so. */
export async function close(run: Run, number: number, notPlanned = false): Promise<Result<true>> {
  return done(await api(run, 'PATCH', `${REPO}/issues/${number}`, [['state', 'closed'], ...(notPlanned ? [['state_reason', 'not_planned'] as const] : [])]))
}

/** `quiet`: no check reported and GitHub has no workflow run for the head commit, so nothing was triggered for it. */
export type Checks = { state: 'green' | 'red' | 'pending' | 'none'; failing: string[]; quiet?: true }

const RUN_FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'])
const NONE_POLLS = 6
const NONE_WAIT_MS = 5000
const PENDING_POLLS = 240
const PENDING_WAIT_MS = 15_000

/**
 * Where a pull request's checks stand: none reported, one still running, one failed or cancelled (named), or all
 * through. Read at the head commit from both places CI reports to: check runs (GitHub Actions) and commit statuses.
 */
export async function checks(run: Run, pr: number): Promise<Result<Checks>> {
  const pull = `${REPO}/pulls/${pr}`
  const got = await api(run, 'GET', pull)
  if (!got.ok) return fail(got)
  const sha = str(obj(obj(parse(got.value))['head'])['sha'])
  if (!sha) return unexpected('GET', pull)
  const runsAt = `${REPO}/commits/${sha}/check-runs?per_page=${PAGE}`
  const ran = await api(run, 'GET', runsAt)
  if (!ran.ok) return fail(ran)
  const runs = obj(parse(ran.value))['check_runs']
  if (!Array.isArray(runs)) return unexpected('GET', runsAt)
  const statusAt = `${REPO}/commits/${sha}/status`
  const reported = await api(run, 'GET', statusAt)
  if (!reported.ok) return fail(reported)
  const statuses = obj(parse(reported.value))['statuses']
  if (!Array.isArray(statuses)) return unexpected('GET', statusAt)

  const rows: { name: string; is: 'pass' | 'fail' | 'pending' }[] = [
    ...runs.map(obj).map(c => ({ name: str(c['name']), is: str(c['status']) !== 'completed' ? ('pending' as const) : RUN_FAILED.has(str(c['conclusion'])) ? ('fail' as const) : ('pass' as const) })),
    ...statuses.map(obj).map(s => ({ name: str(s['context']), is: str(s['state']) === 'pending' ? ('pending' as const) : str(s['state']) === 'failure' || str(s['state']) === 'error' ? ('fail' as const) : ('pass' as const) })),
  ]
  if (!rows.length) return { ok: true, value: { state: 'none', failing: [] } }
  const failing = rows.filter(c => c.is === 'fail').map(c => c.name)
  if (failing.length) return { ok: true, value: { state: 'red', failing } }
  return { ok: true, value: { state: rows.some(c => c.is === 'pending') ? 'pending' : 'green', failing: [] } }
}

/** How often a first check is waited for when the repository has workflows: five minutes of 5 s polls. */
export const NONE_POLLS_EXPECTED = 60
/** After this many polls with no check (90 s), GitHub is asked whether any workflow run exists for the head commit. */
export const QUIET_POLLS = 18
/** How often in a row a failed call (not a missing gh or login) is asked again before the wait gives up. */
const RETRIES = 3

/**
 * How many workflow runs GitHub Actions has for the pull request's head commit. Zero means no workflow was triggered
 * for it (a `paths-ignore` or `paths` filter left it out): a run exists from the moment it is queued.
 */
export async function workflowRuns(run: Run, pr: number): Promise<Result<number>> {
  const pull = `${REPO}/pulls/${pr}`
  const got = await api(run, 'GET', pull)
  if (!got.ok) return fail(got)
  const sha = str(obj(obj(parse(got.value))['head'])['sha'])
  if (!sha) return unexpected('GET', pull)
  const at = `${REPO}/actions/runs?head_sha=${sha}&per_page=1`
  const r = await api(run, 'GET', at)
  if (!r.ok) return fail(r)
  const n = obj(parse(r.value))['total_count']
  return typeof n === 'number' ? { ok: true, value: n } : unexpected('GET', at)
}

/**
 * Polls a pull request's checks until they are through and answers where they stand; `wait` is the caller's sleep.
 * No checks at first: asked again every 5 s, since CI needs a moment to register after a pull request opens (in a
 * live run the first check appeared 40 s after the pull request). Six more times when the repository is not known to
 * have CI, sixty (five minutes) when `expectsCi` says it has workflows; `none` only when there are still none. With
 * `expectsCi`, from 90 s on GitHub is also asked for the workflow runs of the head commit: zero means no workflow was
 * triggered for this commit (a docs-only change under `paths-ignore`), and the answer is `none` with `quiet` at once.
 * Running: asked again every 15 s, 240 polls at most (an hour), then the last `pending` is the answer. Green or red
 * answers at once. A call that fails (a timeout, the network) is asked again after 5 s, three times in a row at
 * most; a missing gh or login answers at once.
 */
export async function watchChecks(run: Run, pr: number, wait: (ms: number) => Promise<void>, expectsCi = false): Promise<Result<Checks>> {
  const ask = async (): Promise<Result<Checks>> => {
    let r = await checks(run, pr)
    for (let i = 0; !r.ok && r.error !== NO_GH && r.error !== NO_AUTH && i < RETRIES; i++) {
      await wait(NONE_WAIT_MS)
      r = await checks(run, pr)
    }
    return r
  }
  let r = await ask()
  const nonePolls = expectsCi ? NONE_POLLS_EXPECTED : NONE_POLLS
  for (let i = 0; r.ok && r.value.state === 'none' && i < nonePolls; i++) {
    if (expectsCi && i >= QUIET_POLLS && (i - QUIET_POLLS) % 6 === 0) {
      const ran = await workflowRuns(run, pr)
      if (ran.ok && ran.value === 0) return { ok: true, value: { state: 'none', failing: [], quiet: true } }
    }
    await wait(NONE_WAIT_MS)
    r = await ask()
  }
  for (let polls = 1; r.ok && r.value.state === 'pending' && polls < PENDING_POLLS; polls++) {
    await wait(PENDING_WAIT_MS)
    r = await ask()
  }
  return r
}

/** Opens a pull request from `head` into `base` and answers its number; when one is already open for `head`, that one's. */
export async function createPr(run: Run, input: { base: string; head: string; title: string; body: string }): Promise<Result<number>> {
  const endpoint = `${REPO}/pulls`
  const r = await api(run, 'POST', endpoint, [['title', input.title], ['head', input.head], ['base', input.base], ['body', input.body]])
  if (r.ok) {
    const n = obj(parse(r.value))['number']
    return typeof n === 'number' ? { ok: true, value: n } : unexpected('POST', endpoint)
  }
  if (!/A pull request already exists/i.test(r.said)) return fail(r)
  const open = await api(run, 'GET', `${endpoint}?head={owner}:${encodeURIComponent(input.head)}&state=open&per_page=1`)
  if (!open.ok) return fail(open)
  const n = obj(arr(parse(open.value))[0])['number']
  return typeof n === 'number' ? { ok: true, value: n } : fail(r)
}

/** A pull request's head branch and whether GitHub has merged it; an unknown one reads as an empty branch, not merged. */
export async function prInfo(run: Run, pr: number): Promise<Result<{ head: string; merged: boolean }>> {
  const r = await api(run, 'GET', `${REPO}/pulls/${pr}`)
  if (!r.ok) return fail(r)
  const o = obj(parse(r.value))
  const ref = obj(o['head'])['ref']
  return { ok: true, value: { head: typeof ref === 'string' ? ref : '', merged: o['merged'] === true || typeof o['merged_at'] === 'string' } }
}

/** A pull request as `adopt` needs it: its title, text, head branch and whether it is open, closed or merged. */
export async function prDetail(run: Run, pr: number): Promise<Result<{ title: string; body: string; head: string; state: 'open' | 'closed' | 'merged' }>> {
  const endpoint = `${REPO}/pulls/${pr}`
  const r = await api(run, 'GET', endpoint)
  if (!r.ok) return fail(r)
  const o = obj(parse(r.value))
  if (typeof o['number'] !== 'number') return unexpected('GET', endpoint)
  const merged = o['merged'] === true || typeof o['merged_at'] === 'string'
  return { ok: true, value: { title: str(o['title']), body: str(o['body']), head: str(obj(o['head'])['ref']), state: merged ? 'merged' : str(o['state']) === 'closed' ? 'closed' : 'open' } }
}

/** Replaces a pull request's body: `adopt` adds the line that closes the issue on merge. */
export async function setPrBody(run: Run, pr: number, body: string): Promise<Result<true>> {
  return done(await api(run, 'PATCH', `${REPO}/pulls/${pr}`, [['body', body]]))
}

/** Merges a pull request now, with a merge commit or squashed. Never auto-merge: that needs a repository setting. */
export async function mergePr(run: Run, pr: number, method: 'merge' | 'squash'): Promise<Result<true>> {
  return done(await api(run, 'PUT', `${REPO}/pulls/${pr}/merge`, [['merge_method', method]]))
}

/** Creates each label; one that already exists (422) is no error. Stops at the first failure. */
export async function ensureLabels(run: Run, names: string[]): Promise<Result<true>> {
  for (const name of names) {
    const r = await api(run, 'POST', `${REPO}/labels`, [['name', name], ['color', '6f42c1']])
    if (!r.ok && !/already_exists|Validation Failed/i.test(r.said)) return fail(r)
  }
  return { ok: true, value: true }
}
