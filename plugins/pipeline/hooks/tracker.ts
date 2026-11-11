// GitHub issues through the gh CLI. The only module that builds a gh argument list: the caller hands in `run`, which
// runs an argv without a shell and answers null when gh cannot be started. Pure apart from `run`: no state, no engine.

export type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string } | null>
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
export type IssueComment = { id: string; author: string; association: string; body: string; at: string }
export type Issue = { number: number; title: string; body: string; author: string; labels: string[]; assignees: string[]; state: 'open' | 'closed'; url: string; createdAt: string; comments: IssueComment[] }

export const SPEC_MARK = '<!-- pipeline:spec -->'
export const QUESTION_MARK = '<!-- pipeline:question -->'
export const NO_GH = 'gh is not installed or not on PATH: install the GitHub CLI, then run gh auth login'
export const NO_AUTH = 'gh is not logged in: run gh auth login'

const FIELDS = 'number,title,body,author,labels,assignees,state,url,createdAt,comments'
const AUTH = /gh auth login|not logged in|authentication/i

/** Runs gh with the arguments and answers its stdout, or the error the rules give for no gh, no login or a failure. */
async function gh(run: Run, args: string[]): Promise<Result<string>> {
  const r = await run(['gh', ...args])
  if (r === null) return { ok: false, error: NO_GH }
  if (r.exitCode !== 0) {
    if (AUTH.test(r.stderr)) return { ok: false, error: NO_AUTH }
    return { ok: false, error: `gh: ${r.stderr.split('\n')[0]!.trim()}` }
  }
  return { ok: true, value: r.stdout }
}

const unexpected = (args: string[]): { ok: false; error: string } => ({ ok: false, error: `gh: unexpected output from ${args.slice(0, 2).join(' ')}` })

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const login = (v: unknown): string => (v && typeof v === 'object' ? str((v as { login?: unknown }).login) : '')
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const commentId = (url: string): string => /#issuecomment-(\d+)/.exec(url)?.[1] ?? ''

/** One issue of gh's JSON in our shape; null when it is not an object with a number. */
function toIssue(raw: unknown): Issue | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o['number'] !== 'number') return null
  return {
    number: o['number'],
    title: str(o['title']),
    body: str(o['body']),
    author: login(o['author']),
    labels: arr(o['labels']).map(l => (l && typeof l === 'object' ? str((l as { name?: unknown }).name) : '')).filter(Boolean),
    assignees: arr(o['assignees']).map(login).filter(Boolean),
    state: str(o['state']).toLowerCase() === 'closed' ? 'closed' : 'open',
    url: str(o['url']),
    createdAt: str(o['createdAt']),
    comments: arr(o['comments']).map(c => {
      const m = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
      return { id: commentId(str(m['url'])), author: login(m['author']), association: str(m['authorAssociation']), body: str(m['body']), at: str(m['createdAt']) }
    }),
  }
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The login gh is signed in as. */
export async function me(run: Run): Promise<Result<string>> {
  const args = ['api', 'user', '--jq', '.login']
  const r = await gh(run, args)
  if (!r.ok) return r
  const name = r.value.trim()
  return name ? { ok: true, value: name } : unexpected(args)
}

/** The open issues with the label, in ascending number. */
export async function list(run: Run, label: string): Promise<Result<Issue[]>> {
  const args = ['issue', 'list', '--label', label, '--state', 'open', '--limit', '200', '--json', FIELDS]
  const r = await gh(run, args)
  if (!r.ok) return r
  const raw = parse(r.value)
  if (!Array.isArray(raw)) return unexpected(args)
  const issues = raw.map(toIssue)
  if (issues.some(i => i === null)) return unexpected(args)
  return { ok: true, value: (issues as Issue[]).sort((a, b) => a.number - b.number) }
}

/** One issue by number, open or closed. */
export async function read(run: Run, number: number): Promise<Result<Issue>> {
  const args = ['issue', 'view', String(number), '--json', FIELDS]
  const r = await gh(run, args)
  if (!r.ok) return r
  const issue = toIssue(parse(r.value))
  return issue ? { ok: true, value: issue } : unexpected(args)
}

/** Opens an issue and answers its number, read from the URL gh prints. */
export async function create(run: Run, input: { title: string; body: string; labels: string[] }): Promise<Result<number>> {
  const args = ['issue', 'create', '--title', input.title, '--body', input.body]
  if (input.labels.length) args.push('--label', input.labels.join(','))
  const r = await gh(run, args)
  if (!r.ok) return r
  const n = /\/issues\/(\d+)/.exec(r.value)?.[1]
  return n ? { ok: true, value: Number(n) } : unexpected(args)
}

/** Comments on an issue and answers the new comment's id, read from the URL gh prints. */
export async function comment(run: Run, number: number, body: string): Promise<Result<string>> {
  const args = ['issue', 'comment', String(number), '--body', body]
  const r = await gh(run, args)
  if (!r.ok) return r
  const id = commentId(r.value)
  return id ? { ok: true, value: id } : unexpected(args)
}

/** Replaces a comment's body. `{owner}/{repo}` is literal: gh fills it from the checkout. */
export async function editComment(run: Run, id: string, body: string): Promise<Result<true>> {
  const r = await gh(run, ['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/comments/${id}`, '-f', `body=${body}`])
  return r.ok ? { ok: true, value: true } : r
}

/** Adds and removes labels, adds an assignee and takes one off; a change that names nothing makes no call. */
export async function edit(run: Run, number: number, change: { add?: string[]; remove?: string[]; assign?: string; unassign?: string }): Promise<Result<true>> {
  const flags: string[] = []
  if (change.add?.length) flags.push('--add-label', change.add.join(','))
  if (change.remove?.length) flags.push('--remove-label', change.remove.join(','))
  if (change.assign) flags.push('--add-assignee', change.assign)
  if (change.unassign) flags.push('--remove-assignee', change.unassign)
  if (!flags.length) return { ok: true, value: true }
  const r = await gh(run, ['issue', 'edit', String(number), ...flags])
  return r.ok ? { ok: true, value: true } : r
}

/** Replaces an issue's body. Used only on issues the tool opened itself (a migrated item's dependencies). */
export async function setBody(run: Run, number: number, body: string): Promise<Result<true>> {
  const r = await gh(run, ['issue', 'edit', String(number), '--body', body])
  return r.ok ? { ok: true, value: true } : r
}

/** Closes an issue. */
export async function close(run: Run, number: number): Promise<Result<true>> {
  const r = await gh(run, ['issue', 'close', String(number)])
  return r.ok ? { ok: true, value: true } : r
}

/** Creates each label; --force makes an existing one no error. Stops at the first failure. */
export async function ensureLabels(run: Run, names: string[]): Promise<Result<true>> {
  for (const name of names) {
    const r = await gh(run, ['label', 'create', name, '--force'])
    if (!r.ok) return r
  }
  return { ok: true, value: true }
}
