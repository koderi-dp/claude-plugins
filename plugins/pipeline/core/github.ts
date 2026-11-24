// The GitHub queue: the open issues as the backlog, their spec comments, questions and answers.
import { PRINCIPLES_FILE, PRINCIPLES_STARTER } from './plan'
import { read, update } from './state'
import type { Host } from './host'
import type { Backlog, Config, Ledger } from '../types'
import { itemState } from './answers'
import type { Readiness } from './backlog'
import { DEFAULTS, normalizeConfig } from './config'
import { paths, places, serialize } from './files'
import type { Places } from './files'
import { EMPTY_EXTRAS, applyOps, extrasOf, isAnswered, issueBodyOf, labelsOf, needsOf, opsFor, parseSpecComment, renderSpecComment, specCommentOf, specFromIssue, toBacklog, withNeeds } from './queue'
import type { Extras, Op } from './queue'
import { DECLINED_MARK, QUESTION_MARK } from './tracker'
import type { Issue, Run } from './tracker'
import { worktreePath } from './actions'
import { CONFIG_FILE, backlog, config, fileError, loadBacklog, loadJson, self } from './shared'
import type { Loaded } from './shared'
import { Refused, nowIso } from './tool'
import type { ToolInput } from './tool'
import { readText } from './watchdog'
import * as tracker from './tracker'

export const ISSUES_FILE = '.git/pipeline/issues.json'
export const WORKTREES_IGNORE = '.claude/worktrees/'
export const ITEMS_FILE = '.git/pipeline/items.json'
export const CACHE_MS = 60_000

/** What the issues answered: the issues the backlog maps (labelled, or with an entry in items.json), the extras, the gh user, how old the cache is when gh failed, the tracker's error when nothing could be read, and the in-flight ids that lost the queue label. */
export type Queue = { issues: Issue[]; extras: Extras; me: string; stale: string | null; error: string | null; lost: string[] }
export type IssueCache = { at: number; me: string; issues: Issue[] }

/** Whether the config says the issues are the queue. */
export const isGithub = (c: Config | null): boolean => normalizeConfig(c ?? DEFAULTS).config.queue === 'github'
export const labelOf = (c: Config | null): string => normalizeConfig(c ?? DEFAULTS).config.queueLabel

/** Where an item's records live in the configured queue mode: with queue: file, the docs/pipeline paths as before. Every record path in this file comes from here. */
export const placesOf = (found: string, c: Config | null): Places => places(found, isGithub(c) ? 'github' : 'file')

/** A path under the main checkout as the checkout names it (`docs/pipeline/ledgers/p1.json`, `.git/pipeline/12/ledger.json`). */
export const relOf = (found: string, path: string): string => (path.startsWith(`${found}/`) ? path.slice(found.length + 1) : path)

/** Makes sure .git/info/exclude ignores `.pipeline/`, the records' folder in every worktree; local, never committed. */
export async function ensureExclude(h: Host, found: string): Promise<void> {
  const exclude = places(found, 'github').exclude
  const had = (await readText(h, exclude)) ?? ''
  if (!had.split('\n').some(l => l.trim() === '.pipeline/')) await h.fs.write(exclude, `${had}${had && !had.endsWith('\n') ? '\n' : ''}.pipeline/\n`)
}

/** Makes sure the project's .gitignore ignores `.claude/worktrees/`, where the pipeline makes its worktrees; a missing file is created. */
export async function ensureIgnore(h: Host, found: string): Promise<void> {
  const file = `${found}/.gitignore`
  const had = (await readText(h, file)) ?? ''
  if (!had.split('\n').some(l => l.trim() === WORKTREES_IGNORE)) await h.fs.write(file, `${had}${had && !had.endsWith('\n') ? '\n' : ''}${WORKTREES_IGNORE}\n`)
}

/** A thrown error that says the program is not there, as against one that ran and timed out or was refused. */
export const isMissingProgram = (message: string): boolean => /ENOENT|not found|not recognized|cannot find|no such file/i.test(message)

/**
 * The tracker's `run`: the argv through `h.process.run` in the main checkout. Null only when gh itself is not there;
 * any other thrown error (a timeout, a refused call) is a failed call with the error as what gh said, so the answer
 * names what happened and not a missing gh.
 */
export const ghRun = (h: Host, found: string): Run => async argv => {
  try {
    const r = await h.process.run(argv, { cwd: found, timeoutMs: 30_000 })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isMissingProgram(message)) return null
    return { exitCode: 1, stdout: '', stderr: `the call did not finish (${message.split('\n')[0]!.trim() || 'no reason given'})` }
  }
}

/** The issue cache, or null when it is missing or not the tool's shape. */
export async function readCache(h: Host, found: string): Promise<IssueCache | null> {
  try {
    const loaded = await loadJson<IssueCache>(h, places(found, 'github').issues, ISSUES_FILE)
    const v = loaded.value
    return v && typeof v.at === 'number' && typeof v.me === 'string' && Array.isArray(v.issues) ? v : null
  } catch {
    return null
  }
}

/** Changes the cached issues; without a cache, starts one that the next load lists again. */
export async function editCache(h: Host, found: string, change: (issues: Issue[]) => Issue[]): Promise<void> {
  const cache = await readCache(h, found)
  await h.fs.write(places(found, 'github').issues, serialize({ at: cache?.at ?? 0, me: cache?.me ?? self.me, issues: change(cache?.issues ?? []) }))
}

/** items.json: missing reads as no extras; a file that does not parse gives its error and is never overwritten. */
export async function readExtras(h: Host, found: string): Promise<Loaded<Extras>> {
  const loaded = await loadJson<Partial<Extras>>(h, places(found, 'github').items, ITEMS_FILE)
  if (loaded.error) return { value: null, error: loaded.error }
  const v = loaded.value
  const items = v && v.items && typeof v.items === 'object' && !Array.isArray(v.items) ? v.items : {}
  const pending = v && Array.isArray(v.pending) ? v.pending : []
  const leftover = (v && Array.isArray(v.leftover) ? v.leftover : []).filter(l => l && typeof l.id === 'string' && typeof l.worktree === 'string' && typeof l.branch === 'string')
  return { value: v ? { items, pending, ...(leftover.length ? { leftover } : {}) } : { ...EMPTY_EXTRAS, items: {}, pending: [] }, error: null }
}

export async function extrasOrRefuse(h: Host, found: string): Promise<Extras> {
  const ex = await readExtras(h, found)
  if (ex.error || !ex.value) throw new Refused(ex.error ?? `${ITEMS_FILE} could not be read`)
  return ex.value
}

export const writeExtras = (h: Host, found: string, extras: Extras) => h.fs.write(places(found, 'github').items, serialize(extras))

/**
 * The issues of the queue: the cache when it is younger than a minute; else the gh user (once per session) and the
 * labelled open issues, plus each issue items.json names that the list does not show, written back to the cache.
 * When gh fails the cache answers with its age, and without one the tracker's error is the answer.
 */
export async function loadQueue(h: Host, found: string, c: Config | null): Promise<Queue> {
  const label = labelOf(c)
  const ex = await readExtras(h, found)
  if (ex.error || !ex.value) return { issues: [], extras: EMPTY_EXTRAS, me: self.me, stale: null, error: ex.error, lost: [] }
  const extras = ex.value
  const at = await h.clock.now()
  const cache = await readCache(h, found)
  let issues: Issue[]
  let me: string
  let stale: string | null = null
  if (cache && at >= cache.at && at - cache.at < CACHE_MS) {
    issues = cache.issues
    me = cache.me || self.me
  } else {
    const run = ghRun(h, found)
    // A minute after gh failed, it is not asked again: the redraws and the tick would each wait on it.
    const down = self.ghDown && at >= self.ghDown.at && at - self.ghDown.at < CACHE_MS ? self.ghDown : null
    const who: tracker.Result<string> = down ? { ok: false, error: down.error } : self.me ? { ok: true, value: self.me } : await tracker.me(run)
    const listed = who.ok ? await tracker.list(run, label) : who
    if (!who.ok || !listed.ok) {
      const error = !who.ok ? who.error : !listed.ok ? listed.error : ''
      if (!down) self.ghDown = { at, error }
      if (!cache) return { issues: [], extras, me: self.me, stale: null, error, lost: [] }
      issues = cache.issues
      me = cache.me || self.me
      stale = `issues read ${Math.max(0, Math.floor((at - cache.at) / 60_000))} min ago`
    } else {
      self.ghDown = null
      me = who.value
      issues = [...listed.value]
      for (const id of Object.keys(extras.items)) {
        if (!/^\d+$/.test(id) || issues.some(i => String(i.number) === id)) continue
        const one = await tracker.read(run, Number(id))
        const known = one.ok ? one.value : cache?.issues.find(i => String(i.number) === id)
        if (known) issues.push(known)
      }
      await h.fs.write(places(found, 'github').issues, serialize({ at, me, issues }))
    }
  }
  self.me = me
  const shown = issues.filter(i => i.labels.includes(label) || extras.items[String(i.number)] !== undefined)
  const lost = shown.filter(i => i.state === 'open' && !i.labels.includes(label)).map(i => String(i.number))
  return { issues: shown, extras, me, stale, error: null, lost }
}

/**
 * Runs the tracker operations; the ones that succeed go into the cache, the ones that fail are appended to the
 * pending list in items.json. Answers how many are pending.
 */
export async function pushOps(h: Host, found: string, c: Config | null, ops: Op[]): Promise<number> {
  const extras = await extrasOrRefuse(h, found)
  const run = ghRun(h, found)
  const cache = await readCache(h, found)
  const me = cache?.me || self.me
  const done: Op[] = []
  const failed: Op[] = []
  for (const op of ops) {
    let r: tracker.Result<true>
    if (op.kind === 'edit') {
      r = await tracker.edit(run, Number(op.id), { add: op.add, remove: op.remove, ...(op.assign ? { assign: op.assign } : {}) })
    } else if (op.kind === 'status') {
      const issue = cache?.issues.find(i => String(i.number) === op.id)
      const spec = issue ? specCommentOf(issue, me) : null
      // No spec comment to rewrite: there is nothing to say the status on.
      if (!spec || !spec.id) continue
      r = await tracker.editComment(run, spec.id, renderSpecComment(parseSpecComment(spec.body).specMd, op.state, op.detail))
    } else {
      r = await tracker.close(run, Number(op.id))
    }
    ;(r.ok ? done : failed).push(op)
  }
  if (cache && done.length) await h.fs.write(places(found, 'github').issues, serialize({ ...cache, issues: applyOps(cache.issues, done, labelOf(c), me) }))
  const pending = [...extras.pending, ...failed]
  await writeExtras(h, found, { ...extras, pending })
  self.ghPending = pending.length
  return pending.length
}

/** The backlog the issues make, kept with its readiness; an answered question's label is taken off. */
export async function loadIssueBacklog(h: Host, found: string, c: Config | null): Promise<Loaded<Backlog>> {
  try {
    const q = await loadQueue(h, found, c)
    self.queue = q
    if (q.error) {
      self.readiness = {}
      await update(h, backlog, () => null)
      return { value: null, error: q.error }
    }
    const label = labelOf(c)
    // The updates still pending show as done: the cache keeps what GitHub said, the backlog what the tool left.
    const mapped = toBacklog(applyOps(q.issues, q.extras.pending, label, q.me), q.extras, label, q.me)
    self.readiness = mapped.readiness
    const needsInfo = labelsOf(label).needsInfo
    // Once per answer: an op already pending is not queued again by every redraw.
    const ops: Op[] = mapped.answered
      .filter(id => !q.extras.pending.some(o => o.kind === 'edit' && o.id === id && o.remove.includes(needsInfo)))
      .map(id => ({ kind: 'edit', id, add: [], remove: [needsInfo] }))
    if (ops.length) await pushOps(h, found, c, ops)
    await update(h, backlog, () => mapped.backlog)
    return { value: mapped.backlog, error: null }
  } catch (err) {
    self.readiness = {}
    await update(h, backlog, () => null)
    return { value: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Retries what is pending, turns the change from the loaded backlog to `next` into tracker operations, keeps the extras. */
export async function writeIssueBacklog(h: Host, found: string, c: Config | null, next: Backlog): Promise<{ backlog: Backlog; readiness: Record<string, Readiness> }> {
  const label = labelOf(c)
  const q = await loadQueue(h, found, c)
  if (q.error) throw new Refused(q.error)
  const before = (await read(h, backlog)) ?? toBacklog(q.issues, q.extras, label, q.me).backlog
  if (q.extras.pending.length) {
    await writeExtras(h, found, { ...q.extras, pending: [] })
    await pushOps(h, found, c, q.extras.pending)
  }
  const issues = (await readCache(h, found))?.issues ?? q.issues
  await pushOps(h, found, c, opsFor(before, next, issues, label, q.me))
  const kept = extrasOf(next, await extrasOrRefuse(h, found))
  await writeExtras(h, found, kept)
  const after = ((await readCache(h, found))?.issues ?? issues).filter(i => i.labels.includes(label) || kept.items[String(i.number)] !== undefined)
  self.readiness = toBacklog(applyOps(after, kept.pending, label, q.me), kept, label, q.me).readiness
  await update(h, backlog, () => next)
  await update(h, fileError, () => null)
  return { backlog: next, readiness: self.readiness }
}

/** An item's one-line state after a GitHub action changed its issue: the backlog loaded again from the cache. */
export async function issueState(h: Host, found: string, id: string, fallback: string): Promise<string> {
  const b = (await loadBacklog(h, found)).value
  const item = b?.items.find(i => i.id === id)
  return item ? itemState(item, self.readiness) : fallback
}

/** `add`: a labelled issue; the cache takes it. */
export async function addIssue(h: Host, found: string, c: Config | null, e: ToolInput): Promise<string> {
  const title = typeof e.item === 'string' ? undefined : e.item?.title?.trim()
  if (!title) throw new Refused('add needs item.title')
  // The issues this one waits for go on a `Needs:` line of the body, where the tool reads them back.
  const needs = typeof e.item === 'string' || !Array.isArray(e.item?.needs) ? [] : e.item.needs.map(n => String(n).replace(/^#/, '')).filter(n => /^\d+$/.test(n))
  // Who asked and when goes on the issue too: it is the only record the item has.
  const note = typeof e.item === 'string' ? '' : (e.item?.note ?? '').trim()
  const source = typeof e.item === 'string' ? '' : (e.item?.source ?? '').trim()
  // A spec given with the request is the issue's description too, so the issue reads as the request on its own
  // page; the spec comment under it stays what the tool reads and rewrites.
  const spec = typeof e.text === 'string' && e.text.trim() ? e.text : null
  const body = withNeeds(issueBodyOf(spec, [note, source ? `Source: ${source}` : ''].filter(Boolean).join('\n\n')), needs)
  const r = await tracker.create(ghRun(h, found), { title, body, labels: [labelOf(c)] })
  if (!r.ok) throw new Refused(r.error)
  const n = r.value
  const at = await nowIso(h)
  await editCache(h, found, issues => [...issues.filter(i => i.number !== n), { number: n, title, body, author: self.me, labels: [labelOf(c)], assignees: [], state: 'open', url: '', createdAt: at, comments: [] }])
  // A milestone named with the item: the issue exists either way, and a milestone that cannot be set is said.
  const wanted = typeof e.item === 'string' ? undefined : (e.item as { milestone?: unknown } | undefined)?.milestone
  let milestone = ''
  if (typeof wanted === 'string' && wanted.trim()) {
    try {
      milestone = ` · milestone ${await putInMilestone(h, found, n, wanted)}`
    } catch (err) {
      milestone = ` · milestone not set: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return `added ${n} · ${await issueState(h, found, String(n), 'inbox · no spec')}${milestone}`
}

/**
 * Puts an issue in the open milestone of that title (the case of the letters does not matter), or takes it out of
 * its milestone when the title is empty or null. Answers the milestone's title, or `none`; refuses a title no open
 * milestone has, naming the ones there are.
 */
export async function putInMilestone(h: Host, found: string, issue: number, wanted: unknown): Promise<string> {
  const run = ghRun(h, found)
  if (wanted === null || (typeof wanted === 'string' && !wanted.trim())) {
    const r = await tracker.setMilestone(run, issue, null)
    if (!r.ok) throw new Refused(r.error)
    return 'none'
  }
  if (typeof wanted !== 'string') throw new Refused('update: milestone is the title of an open milestone, or null to take the issue out of its milestone')
  const open = await tracker.milestones(run)
  if (!open.ok) throw new Refused(open.error)
  const hit = open.value.find(m => m.title.trim().toLowerCase() === wanted.trim().toLowerCase())
  if (!hit) throw new Refused(`no open milestone "${wanted.trim()}"${open.value.length ? `; the open ones: ${open.value.map(m => m.title).join(', ')}` : '; the repository has no open milestone'}`)
  const r = await tracker.setMilestone(run, issue, hit.number)
  if (!r.ok) throw new Refused(r.error)
  return hit.title
}

/**
 * `update` with `title`, `body`, `needs` or `milestone` under queue github: the issue's own text and its milestone,
 * written through the tool so the `Needs:` line is never lost and nobody edits an issue with gh. A new body that names no dependencies keeps the ones the issue had; `needs`
 * sets them, and an empty list removes them. Answers what it changed.
 */
export async function editIssueText(h: Host, found: string, id: string, set: Record<string, unknown>): Promise<string[]> {
  const run = ghRun(h, found)
  const issue = (await readCache(h, found))?.issues.find(i => String(i.number) === id) ?? self.queue?.issues.find(i => String(i.number) === id)
  if (!issue) throw new Refused(`no issue ${id} in the queue`)
  const done: string[] = []
  let title = issue.title
  let body = issue.body
  if ('title' in set) {
    if (typeof set['title'] !== 'string' || !set['title'].trim()) throw new Refused('update: title is text')
    if (set['title'].trim() !== issue.title) {
      const r = await tracker.setTitle(run, issue.number, set['title'].trim())
      if (!r.ok) throw new Refused(r.error)
      title = set['title'].trim()
      done.push('title')
    }
  }
  if ('body' in set || 'needs' in set) {
    if ('body' in set && typeof set['body'] !== 'string') throw new Refused('update: body is text')
    if ('needs' in set && !Array.isArray(set['needs'])) throw new Refused('update: needs is a list of issue numbers')
    const given = typeof set['body'] === 'string' ? set['body'] : issue.body
    const needs = Array.isArray(set['needs'])
      ? set['needs'].map(n => String(n).replace(/^#/, '')).filter(n => /^\d+$/.test(n))
      : needsOf(/^\s*Needs:\s/im.test(given) ? given : issue.body)
    const next = withNeeds(given, needs)
    if (next !== issue.body) {
      const r = await tracker.setBody(run, issue.number, next)
      if (!r.ok) throw new Refused(r.error)
      body = next
      if ('body' in set) done.push('body')
      if ('needs' in set || needsOf(issue.body).join() !== needs.join()) done.push('needs')
    }
  }
  if (done.length) await editCache(h, found, issues => issues.map(i => (i.number === issue.number ? { ...i, title, body } : i)))
  if ('milestone' in set) done.push(`milestone ${await putInMilestone(h, found, issue.number, set['milestone'])}`)
  return done.length ? [...new Set(done)] : ['nothing: the issue already reads so']
}

/** `spec`: edits the spec comment (its state and detail kept) or posts one as ready; rewrites the worktree's spec.md. */
export async function specIssue(h: Host, found: string, id: string, e: ToolInput): Promise<string> {
  const body = typeof e.text === 'string' ? e.text : ''
  if (!body.trim()) throw new Refused('spec needs text')
  const run = ghRun(h, found)
  const me = self.me
  const issue = (await readCache(h, found))?.issues.find(i => String(i.number) === id) ?? self.queue?.issues.find(i => String(i.number) === id)
  const old = issue ? specCommentOf(issue, me) : null
  const at = await nowIso(h)
  if (old) {
    const was = parseSpecComment(old.body)
    const rendered = renderSpecComment(body, was.state || 'ready', was.detail)
    const r = await tracker.editComment(run, old.id, rendered)
    if (!r.ok) throw new Refused(r.error)
    await editCache(h, found, issues => issues.map(i => (String(i.number) === id ? { ...i, comments: i.comments.map(cm => (cm.id === old.id ? { ...cm, body: rendered } : cm)) } : i)))
  } else {
    const rendered = renderSpecComment(body, 'ready', '')
    const r = await tracker.comment(run, Number(id), rendered)
    if (!r.ok) throw new Refused(r.error)
    await editCache(h, found, issues => issues.map(i => (String(i.number) === id ? { ...i, comments: [...i.comments, { id: r.value, author: me, association: '', body: rendered, at }] } : i)))
  }
  const P = places(found, 'github')
  const ledger = (await loadJson<Ledger>(h, P.ledger(id), `.git/pipeline/${id}/ledger.json`)).value
  if (ledger && typeof ledger.worktree === 'string' && ledger.worktree) await h.fs.write(`${worktreePath(found, ledger)}/${P.specRel(id)}`, body)
  return `${id} · ${await issueState(h, found, id, 'ready')} · spec posted`
}

/** `question`: a marked comment on the issue and the needs-info label. */
export async function questionIssue(h: Host, found: string, c: Config | null, id: string, e: ToolInput): Promise<string> {
  const question = typeof e.text === 'string' ? e.text.trim() : ''
  if (!question) throw new Refused('question needs text')
  const posted = `${QUESTION_MARK}\n${question}`
  const r = await tracker.comment(ghRun(h, found), Number(id), posted)
  if (!r.ok) throw new Refused(r.error)
  const at = await nowIso(h)
  await editCache(h, found, issues => issues.map(i => (String(i.number) === id ? { ...i, comments: [...i.comments, { id: r.value, author: self.me, association: '', body: posted, at }] } : i)))
  await pushOps(h, found, c, [{ kind: 'edit', id, add: [labelsOf(labelOf(c)).needsInfo], remove: [] }])
  return `${id} · ${await issueState(h, found, id, 'inbox · open question on the issue')}`
}

/**
 * `answer`: what the user said in the session, written on the issue as a plain comment by the gh user. That is the
 * same thing that ends the hold when the author answers on GitHub, so the question and its answer are both on the
 * issue, the only record the item has.
 */
export async function answerIssue(h: Host, found: string, c: Config | null, id: string, e: ToolInput): Promise<string> {
  const answer = typeof e.text === 'string' ? e.text.trim() : ''
  if (!answer) throw new Refused('answer needs text')
  const issue = (await readCache(h, found))?.issues.find(i => String(i.number) === id) ?? self.queue?.issues.find(i => String(i.number) === id)
  if (!issue) throw new Refused(`no issue ${id} in the queue`)
  const needsInfo = labelsOf(labelOf(c)).needsInfo
  if (!issue.labels.includes(needsInfo) || isAnswered(issue, self.me)) throw new Refused(`${id} has no open question`)
  const posted = `Answered in the session: ${answer}`
  const r = await tracker.comment(ghRun(h, found), Number(id), posted)
  if (!r.ok) throw new Refused(r.error)
  const at = await nowIso(h)
  await editCache(h, found, issues => issues.map(i => (String(i.number) === id ? { ...i, comments: [...i.comments, { id: r.value, author: self.me, association: '', body: posted, at }] } : i)))
  await pushOps(h, found, c, [{ kind: 'edit', id, add: [], remove: [needsInfo] }])
  return `${id} · ${await issueState(h, found, id, 'ready')} · answer on the issue`
}

/**
 * `remove` with queue: github: the issue is closed as not planned, with the reason written on it as a marked comment.
 * Refused for an item being built or in review, and without a reason. The state labels go, the queue label stays as
 * the record that it was asked for here.
 */
export async function declineIssue(h: Host, found: string, c: Config | null, current: Backlog, id: string, e: ToolInput): Promise<string> {
  const reason = typeof e.text === 'string' ? e.text.trim() : ''
  if (!reason) throw new Refused('remove with queue: github closes the issue as not planned and needs "text": the reason, which is written on the issue')
  if (!/^\d+$/.test(id)) throw new Refused(`no item ${id}`)
  const there = current.items.find(i => i.id === id)
  if (there && ['planning', 'building', 'review'].includes(there.status)) throw new Refused(`${id} is ${there.status}: stop it or finish it first`)
  const issue = await readIssue(h, found, id)
  if (issue.state === 'closed') throw new Refused(`${id} is already closed`)
  const run = ghRun(h, found)
  const said = await tracker.comment(run, Number(id), `${DECLINED_MARK}\nClosed as not planned: ${reason}`)
  if (!said.ok) throw new Refused(said.error)
  const closed = await tracker.close(run, Number(id), true)
  if (!closed.ok) throw new Refused(`the reason is on the issue, but it could not be closed: ${closed.error}`)
  const L = labelsOf(labelOf(c))
  const stale = [L.building, L.blocked, L.needsInfo].filter(l => issue.labels.includes(l))
  if (stale.length) await pushOps(h, found, c, [{ kind: 'edit', id, add: [], remove: stale }])
  await editCache(h, found, issues => issues.filter(i => String(i.number) !== id))
  const left = (await loadBacklog(h, found)).value?.items.length ?? 0
  return `${id} closed as not planned · reason on the issue · ${left} item${left === 1 ? '' : 's'} left`
}

/** `unpark`: the issue is not in the list; read it, refuse a closed one, put the queue label back. */
export async function unparkIssue(h: Host, found: string, c: Config | null, current: Backlog, id: string | undefined): Promise<string> {
  if (!id) throw new Refused('an id is needed')
  const there = current.items.find(i => i.id === id)
  if (there) throw new Refused(`${id} is ${there.status}, not parked`)
  if (!/^\d+$/.test(id)) throw new Refused(`no item ${id}`)
  const r = await tracker.read(ghRun(h, found), Number(id))
  if (!r.ok) throw new Refused(r.error)
  if (r.value.state === 'closed') throw new Refused(`${id} is closed`)
  await editCache(h, found, issues => [...issues.filter(i => i.number !== r.value.number), r.value])
  await pushOps(h, found, c, [{ kind: 'edit', id, add: [labelOf(c)], remove: [] }])
  return `${id} · ${await issueState(h, found, id, 'inbox')}`
}

/** One issue read fresh from GitHub (not the cache), written into the cache so the backlog mapped next is true; refused when gh fails. */
export async function readIssue(h: Host, found: string, id: string): Promise<Issue> {
  const r = await tracker.read(ghRun(h, found), Number(id))
  if (!r.ok) throw new Refused(r.error)
  await editCache(h, found, issues => [...issues.filter(i => i.number !== r.value.number), r.value])
  return r.value
}

/**
 * The issue read fresh before `begin` or `start` makes a worktree for it. Refused when it carries the building label and
 * this machine has no ledger for it (another machine builds it, of another user or of this one: one login) unless
 * forced. Answers the issue and its spec: the spec comment's, or the issue's own text when it has none.
 */
export async function claimIssue(h: Host, found: string, c: Config | null, id: string, hasLedger: boolean, force: boolean): Promise<{ issue: Issue; specMd: string }> {
  const issue = await readIssue(h, found, id)
  if (issue.labels.includes(labelsOf(labelOf(c)).building) && !hasLedger && !force) {
    const other = issue.assignees.find(a => a !== self.me)
    throw new Refused(`${id} is being built ${other ? `elsewhere (by @${other})` : 'on another machine of yours'} · to take it over here: begin with "force": true`)
  }
  // The spec comment when the issue has one; otherwise the issue itself is the spec.
  const spec = specCommentOf(issue, self.me)
  return { issue, specMd: spec ? parseSpecComment(spec.body).specMd : specFromIssue(issue) }
}

/** `init` with queue: github: gh must answer for this repository; the config, the labels and the exclude line, no backlog. */
export async function initGithub(h: Host, found: string, c: Config | null, error: string | null): Promise<string> {
  const p = paths(found)
  const hasConfig = await h.fs.exists(p.config)
  if (hasConfig && error) throw new Refused(error)
  if (hasConfig && !isGithub(c)) throw new Refused(`${CONFIG_FILE} exists with queue: file; set it with /pipeline config queue=github`)
  const next = hasConfig ? normalizeConfig(c).config : { ...structuredClone(DEFAULTS), queue: 'github' as const }
  const run = ghRun(h, found)
  const who = self.me ? ({ ok: true, value: self.me } as const) : await tracker.me(run)
  if (!who.ok) throw new Refused(who.error)
  self.me = who.value
  const listed = await tracker.list(run, next.queueLabel)
  if (!listed.ok) throw new Refused(listed.error)
  if (!hasConfig) {
    await h.fs.write(p.config, serialize(next))
    await update(h, config, () => structuredClone(next))
  }
  const hasPrinciples = await h.fs.exists(p.principles)
  if (!hasPrinciples) await h.fs.write(p.principles, PRINCIPLES_STARTER)
  const L = labelsOf(next.queueLabel)
  const names = [L.queue, L.building, L.blocked, L.needsInfo]
  const labelled = await tracker.ensureLabels(run, names)
  if (!labelled.ok) throw new Refused(labelled.error)
  await ensureExclude(h, found)
  await ensureIgnore(h, found)
  await update(h, fileError, () => null)
  const wrote = [...(hasConfig ? [] : [CONFIG_FILE]), ...(hasPrinciples ? [] : [PRINCIPLES_FILE])]
  const head = hasConfig ? `exists: ${CONFIG_FILE}${hasPrinciples ? '' : ` · wrote ${PRINCIPLES_FILE}`}` : `wrote ${wrote.join(', ')}`
  return `${head} · labels ${names.join(', ')}${wrote.length ? ` · commit ${wrote.join(' and ')} on ${next.mainBranch}` : ''}`
}
