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
async function api(run: Run, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', endpoint: string, fields: Field[] = []): Promise<Called> {
  const r = await run(['gh', 'api', ...(method === 'GET' ? [] : ['-X', method]), endpoint, ...fields.flatMap(([k, v]) => ['-f', `${k}=${v}`])])
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

/** Closes an issue. */
export async function close(run: Run, number: number): Promise<Result<true>> {
  return done(await api(run, 'PATCH', `${REPO}/issues/${number}`, [['state', 'closed']]))
}

export type Checks = { state: 'green' | 'red' | 'pending' | 'none'; failing: string[] }

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

/**
 * Polls a pull request's checks until they are through and answers where they stand; `wait` is the caller's sleep.
 * No checks at first: asked again every 5 s, six more times, since CI needs a moment to register after a pull
 * request opens, and `none` only when there are still none. Running: asked again every 15 s, 240 polls at most (an
 * hour), then the last `pending` is the answer. Green or red answers at once.
 */
export async function watchChecks(run: Run, pr: number, wait: (ms: number) => Promise<void>): Promise<Result<Checks>> {
  let r = await checks(run, pr)
  for (let i = 0; r.ok && r.value.state === 'none' && i < NONE_POLLS; i++) {
    await wait(NONE_WAIT_MS)
    r = await checks(run, pr)
  }
  for (let polls = 1; r.ok && r.value.state === 'pending' && polls < PENDING_POLLS; polls++) {
    await wait(PENDING_WAIT_MS)
    r = await checks(run, pr)
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
