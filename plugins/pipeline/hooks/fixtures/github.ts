// A small in-memory GitHub that answers the REST calls the tracker makes through `gh api`. For the tests only: it
// routes on method and endpoint, mutates the state it is given and answers REST-shaped JSON, with gh's exit code and
// stderr for a refusal.

import type { Issue } from '../tracker'

export type RestState = {
  me: string
  issues: Issue[]
  /** The checks of every pull request's head commit, in the buckets `pass`, `fail`, `cancel`, `pending`; null or missing: none reported. */
  checks?: { name: string; bucket: string }[] | null
  /** The labels the repository has, in the order they were created. */
  labels?: string[]
  /** Called after a call changed an issue's labels, assignees, title or body. */
  onEdit?: (i: Issue) => void
  /** The number the next opened pull request gets; 31 when not given. */
  pull?: number
}
export type Answer = { exitCode: number; stdout: string; stderr: string }
export type ApiCall = { method: string; path: string; query: URLSearchParams; fields: [string, string][] }

export const REPO = 'repos/{owner}/{repo}'

/** The argv the tracker builds for one call on the repository: `api('POST', 'issues/2/labels', 'labels[]=x')`. */
export const api = (method: string, path: string, ...fields: string[]): string[] => ['gh', 'api', ...(method === 'GET' ? [] : ['-X', method]), `${REPO}/${path}`, ...fields.flatMap(f => ['-f', f])]

/** `['gh', 'api', ('-X', METHOD)?, endpoint, ('-f', 'k=v')*]` taken apart; null for any other argv. `path` is the endpoint under the repository, without its query. */
export function parseApi(argv: readonly string[]): ApiCall | null {
  if (argv[0] !== 'gh' || argv[1] !== 'api') return null
  let at = 2
  let method = 'GET'
  if (argv[at] === '-X') {
    method = argv[at + 1] ?? ''
    at += 2
  }
  const endpoint = argv[at++]
  if (endpoint === undefined) return null
  const fields: [string, string][] = []
  for (; at < argv.length; at += 2) {
    const pair = argv[at + 1]
    if (argv[at] !== '-f' || pair === undefined || !pair.includes('=')) return null
    fields.push([pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
  }
  const [whole = '', search = ''] = endpoint.split('?')
  return { method, path: whole.startsWith(`${REPO}/`) ? whole.slice(REPO.length + 1) : whole, query: new URLSearchParams(search), fields }
}

/** Whether the argv is the call with this method on this path (a string, or a pattern over the path). */
export const isCall = (argv: readonly string[], method: string, path: string | RegExp): boolean => {
  const c = parseApi(argv)
  return c !== null && c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path))
}

/** The value of a `-f key=value` field of the argv, or undefined. */
export const fieldOf = (argv: readonly string[], key: string): string | undefined => parseApi(argv)?.fields.find(([k]) => k === key)?.[1]

const HEAD_SHA = 'c0ffee0000000000000000000000000000000000'

const restIssue = (i: Issue) => ({
  number: i.number,
  title: i.title,
  body: i.body === '' ? null : i.body,
  user: i.author ? { login: i.author } : null,
  labels: i.labels.map(name => ({ name, color: '6f42c1' })),
  assignees: i.assignees.map(login => ({ login })),
  state: i.state,
  html_url: i.url,
  created_at: i.createdAt,
  comments: i.comments.length,
})

const restComment = (i: Issue, c: Issue['comments'][number]) => ({ id: Number(c.id), html_url: `${i.url}#issuecomment-${c.id}`, user: { login: c.author }, author_association: c.association, body: c.body, created_at: c.at })

/** The function that answers one argv over the state; `now` is the time new issues and comments carry. */
export function restGithub(state: RestState, now: number): (argv: readonly string[]) => Answer {
  let nextComment = 900
  const ok = (value: unknown): Answer => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
  const refuse = (status: number, message: string, errors: unknown[] = []): Answer => ({ exitCode: 1, stdout: JSON.stringify({ message, errors, status: String(status) }), stderr: `gh: ${message} (HTTP ${status})` })
  const paged = (rows: unknown[], query: URLSearchParams): Answer => {
    const per = Number(query.get('per_page') ?? 30)
    const page = Number(query.get('page') ?? 1)
    return ok(rows.slice((page - 1) * per, page * per))
  }
  const many = (c: ApiCall, key: string) => c.fields.filter(([k]) => k === `${key}[]`).map(([, v]) => v)
  const one = (c: ApiCall, key: string) => c.fields.find(([k]) => k === key)?.[1]

  return argv => {
    const c = parseApi(argv)
    if (!c) return { exitCode: 1, stdout: '', stderr: `unknown command ${argv.join(' ')}` }
    const { method, path, query } = c
    const on = (m: string, pattern: RegExp) => (m === method ? pattern.exec(path) : null)
    let m: RegExpExecArray | null

    if (method === 'GET' && path === 'user') return ok({ login: state.me })

    if (on('GET', /^issues$/)) {
      const label = query.get('labels') ?? ''
      const wanted = query.get('state') ?? 'open'
      return paged(state.issues.filter(i => (wanted === 'all' || i.state === wanted) && (!label || i.labels.includes(label))).map(restIssue), query)
    }
    if (on('POST', /^issues$/)) {
      const number = Math.max(0, ...state.issues.map(i => i.number)) + 1
      const made: Issue = { number, title: one(c, 'title') ?? '', body: one(c, 'body') ?? '', author: state.me, labels: many(c, 'labels'), assignees: [], state: 'open', url: `https://github.com/o/r/issues/${number}`, createdAt: new Date(now).toISOString(), comments: [] }
      state.issues.push(made)
      return ok(restIssue(made))
    }
    if ((m = on('PATCH', /^issues\/comments\/(\d+)$/))) {
      const body = one(c, 'body') ?? ''
      for (const i of state.issues) {
        const at = i.comments.findIndex(cm => cm.id === m![1])
        if (at < 0) continue
        i.comments = i.comments.map(cm => (cm.id === m![1] ? { ...cm, body } : cm))
        return ok(restComment(i, i.comments[at]!))
      }
      return refuse(404, 'Not Found')
    }
    if ((m = /^issues\/(\d+)(?:\/(.*))?$/.exec(path))) {
      const i = state.issues.find(x => String(x.number) === m![1])
      if (!i) return refuse(404, 'Not Found')
      const rest = m[2] ?? ''
      if (method === 'GET' && rest === '') return ok(restIssue(i))
      if (method === 'PATCH' && rest === '') {
        const title = one(c, 'title')
        const body = one(c, 'body')
        if (title !== undefined) i.title = title
        if (body !== undefined) i.body = body
        if (one(c, 'state') === 'closed') i.state = 'closed'
        if (title !== undefined || body !== undefined) state.onEdit?.(i)
        return ok(restIssue(i))
      }
      if (method === 'GET' && rest === 'comments') return paged(i.comments.map(cm => restComment(i, cm)), query)
      if (method === 'POST' && rest === 'comments') {
        const made = { id: String(nextComment++), author: state.me, association: 'OWNER', body: one(c, 'body') ?? '', at: new Date(now).toISOString() }
        i.comments.push(made)
        return ok(restComment(i, made))
      }
      if (method === 'POST' && rest === 'labels') {
        i.labels = [...i.labels, ...many(c, 'labels').filter(l => !i.labels.includes(l))]
        state.onEdit?.(i)
        return ok(restIssue(i).labels)
      }
      if (method === 'DELETE' && rest.startsWith('labels/')) {
        const name = decodeURIComponent(rest.slice('labels/'.length))
        if (!i.labels.includes(name)) return refuse(404, 'Label does not exist')
        i.labels = i.labels.filter(l => l !== name)
        state.onEdit?.(i)
        return ok(restIssue(i).labels)
      }
      if (method === 'POST' && rest === 'assignees') {
        for (const who of many(c, 'assignees')) if (!i.assignees.includes(who)) i.assignees.push(who)
        state.onEdit?.(i)
        return ok(restIssue(i))
      }
      if (method === 'DELETE' && rest === 'assignees') {
        const off = many(c, 'assignees')
        i.assignees = i.assignees.filter(a => !off.includes(a))
        state.onEdit?.(i)
        return ok(restIssue(i))
      }
    }
    if (on('POST', /^labels$/)) {
      const name = one(c, 'name') ?? ''
      if (state.labels?.includes(name)) return refuse(422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }])
      ;(state.labels ??= []).push(name)
      return ok({ name, color: one(c, 'color') ?? '' })
    }
    if (on('POST', /^pulls$/)) {
      const number = state.pull ?? 31
      return ok({ number, html_url: `https://github.com/o/r/pull/${number}` })
    }
    if ((m = on('GET', /^pulls\/(\d+)$/))) return ok({ number: Number(m[1]), state: 'open', head: { sha: HEAD_SHA, ref: `feat/${m[1]}` }, merged: false })
    if (on('PUT', /^pulls\/\d+\/merge$/)) return ok({ merged: true, message: 'Pull Request successfully merged' })
    if (on('GET', /^commits\/[0-9a-f]+\/check-runs$/)) {
      const rows = (state.checks ?? []).map(k => ({
        name: k.name,
        status: k.bucket === 'pending' ? 'in_progress' : 'completed',
        conclusion: k.bucket === 'pending' ? null : k.bucket === 'fail' ? 'failure' : k.bucket === 'cancel' ? 'cancelled' : k.bucket === 'skipping' ? 'skipped' : 'success',
      }))
      return ok({ total_count: rows.length, check_runs: rows })
    }
    if (on('GET', /^commits\/[0-9a-f]+\/status$/)) return ok({ state: 'pending', statuses: [], total_count: 0 })
    return refuse(404, 'Not Found')
  }
}
