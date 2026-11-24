// The tool: one action in, one line out. The backlog and ledger actions are here; a run's actions are in ./actions.
import { read, update } from './state'
import type { Host } from './host'
import type { Backlog, Config, Item, Ledger } from '../types'
import { compactSignal, itemState, ledgerLine, slimGet } from './answers'
import { addItem, emptyBacklog, moveItem, removeItem, renderBacklogMd, updateItem } from './backlog'
import type { Readiness } from './backlog'
import { cleanList, planOf } from './clean'
import { DEFAULTS, normalizeConfig } from './config'
import { paths, places, serialize } from './files'
import { emptyLedger, ledgerText, mergeLedger, repairResume, shapeSet } from './ledger'
import type { LedgerSet } from './ledger'
import { candidates as mergeCandidates, fetchArgv, findMerged, isFetchDue } from './merged'
import type { Git, MergedPending } from './merged'
import { quoted } from './queue'
import { tail } from './runner'
import { statusText } from './status'
import type { StatusInput } from './status'
import { PRINCIPLES_FILE, PRINCIPLES_STARTER } from './plan'
import { acceptAction, adoptAction, beginAction, briefAction, closeAction, gateAction, leftoverLines, mergeAction, planAction, prAction, shipAction, startsRun, withoutId } from './actions'
import { startChild, stopChild } from './children'
import { addIssue, answerIssue, declineIssue, editIssueText, ensureIgnore, extrasOrRefuse, initGithub, isGithub, issueState, labelOf, placesOf, questionIssue, relOf, specIssue, unparkIssue, writeIssueBacklog } from './github'
import { migrateApply, migrateDraft, migrateGithub } from './migration'
import { judgeAll, settle } from './readiness'
import { queueRename } from './session'
import { BACKLOG_FILE, BACKLOG_MD_FILE, CONFIG_FILE, agents, backlog, childLog, children, commitLine, config, fileError, loadAll, loadJson, resolveRoot, self, siblings, signals } from './shared'
import type { Loaded } from './shared'
import { activeItem, heartbeat, readText } from './watchdog'

export type ToolInput = {
  action: string
  id?: string
  item?: (Partial<Item> & { title?: string }) | string
  set?: Partial<Item> | LedgerSet
  to?: 'top' | { after: string }
  refresh?: boolean
  full?: boolean
  titles?: boolean
  config?: unknown
  items?: unknown
  rules?: unknown
  kind?: string
  task?: number
  findings?: string
  carried?: string
  commits?: string
  attribution?: string
  escalate?: boolean
  close?: { tokens?: number; minutes?: number; result?: string }
  tokens?: number
  minutes?: number
  verdict?: string
  review?: string
  title?: string
  body?: string
  message?: string
  next?: boolean
  fact?: string
  pr?: string
  force?: boolean
  text?: string
  queue?: string
  apply?: boolean
}

export class Refused extends Error {}

export async function nowIso(h: Host): Promise<string> {
  return new Date(await h.clock.now()).toISOString()
}

/** The ledger of an item as it is on disk, where the queue mode keeps it: missing gives null, bad JSON gives the error with its line. */
export async function readLedger(h: Host, found: string, id: string): Promise<Loaded<Ledger>> {
  const file = placesOf(found, await read(h, config)).ledger(id)
  return loadJson<Ledger>(h, file, relOf(found, file))
}

/**
 * The ledger of an item, when its file is on disk and parses, normalised through the merge so every consumer sees
 * the arrays (a hand-made file, or one from another tool, may leave `tasks`, `rulings` or `blockers` out).
 */
export async function loadLedger(h: Host, found: string, id: string): Promise<Ledger | null> {
  try {
    const parsed = (await readLedger(h, found, id)).value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const set = parsed as unknown as LedgerSet
    const lists = { tasks: Array.isArray(set.tasks) ? set.tasks : [], rulings: Array.isArray(set.rulings) ? set.rulings : [], blockers: Array.isArray(set.blockers) ? set.blockers.filter((b): b is string => typeof b === 'string') : [] }
    // A resume block an earlier version saved from text, one character per key, reads as that text again.
    const resume = repairResume(set.resume, Math.max(1, lists.tasks.length))
    return mergeLedger(emptyLedger(id), { ...set, ...lists, ...(resume ? { resume } : {}) }, await nowIso(h))
  } catch {
    return null
  }
}

/** Everything the status text and the panel draw from, for the files as given. */
/**
 * A value a redraw would read from disk again, kept for `ttlMs` while `ref` (the backlog the atom holds) is the same
 * object. The panel and the band redraw on every step of a subagent; the tool's own answers never go through here.
 */
export async function memo<T>(h: Host, key: string, ref: unknown, ttlMs: number, make: () => Promise<T>): Promise<T> {
  const at = await h.clock.now()
  const hit = self.memo.get(key)
  if (hit && hit.ref === ref && at - hit.at < ttlMs && at >= hit.at) return hit.value as T
  const value = await make()
  self.memo.set(key, { at, ref, value })
  return value
}
export const DRAW_TTL_MS = 3000
export const drawnLedger = (h: Host, found: string, id: string) => memo(h, `ledger:${id}`, null, DRAW_TTL_MS, () => loadLedger(h, found, id))

export async function gather(h: Host, found: string, c: Config | null, b: Backlog | null, error: string | null, isDraw = false): Promise<StatusInput> {
  const active = await activeItem(h, b)
  return {
    activeId: active?.id ?? null,
    config: c,
    backlog: b,
    readiness: !b ? {} : isDraw ? await memo(h, 'readiness', b, 10_000, () => judgeAll(h, found, b)) : await judgeAll(h, found, b),
    ledger: !active ? null : isDraw ? await drawnLedger(h, found, active.id) : await loadLedger(h, found, active.id),
    agents: await read(h, agents),
    signals: await read(h, signals),
    now: await h.clock.now(),
    fileError: error,
    mergedPending: self.mergedPending,
  }
}

export async function statusNow(h: Host, found: string, c: Config | null, b: Backlog | null, error: string | null): Promise<string> {
  return statusText(await gather(h, found, c, b, error))
}

/** The names under a folder, with a slash after each directory; nothing when the folder is not there. */
export async function listDir(h: Host, dir: string): Promise<string[]> {
  try {
    if (!(await h.fs.exists(dir))) return []
    return (await h.fs.list(dir)).map(e => (e.kind === 'dir' ? `${e.name}/` : e.name))
  } catch {
    return []
  }
}

/** The listing `cleanList` wants: the known parents, the superpowers pointers, the worktree names, the local branches and the merged items' ledger branches. With queue: github the records are not in the repository: only the worktrees. */
export async function cleanInput(h: Host, found: string, b: Backlog | null): Promise<{ listing: string[]; planPaths: Record<string, string>; worktrees: string[]; branches: string[]; ledgerBranches: Record<string, string> }> {
  const gh = isGithub(await read(h, config))
  const ledgers = relOf(found, paths(found).ledgers)
  const plans = relOf(found, paths(found).plans)
  const listing: string[] = []
  for (const parent of gh ? ['.claude/worktrees'] : [ledgers, plans, '.superpowers/sdd', '.claude/worktrees']) {
    for (const name of await listDir(h, `${found}/${parent}`)) listing.push(`${parent}/${name}`)
  }
  const planPaths: Record<string, string> = {}
  for (const entry of listing.filter(p => p.startsWith('.superpowers/sdd/') && p.endsWith('/'))) {
    const dir = entry.slice('.superpowers/sdd/'.length, -1)
    const texts: string[] = []
    for (const file of ['plan-path', 'progress.md']) {
      const t = await readText(h, `${found}/${entry}${file}`)
      if (t) texts.push(t)
    }
    if (texts.length) planPaths[dir] = texts.join('\n')
  }
  // A plan kept outside docs/pipeline/plans is listed when it is there.
  for (const item of gh ? [] : b?.items ?? []) {
    if (item.status !== 'merged') continue
    const plan = planOf(item)
    if (!plan.startsWith(`${plans}/`) && (await readText(h, `${found}/${plan}`)) !== null) listing.push(plan)
  }
  const worktrees = listing.filter(p => p.startsWith('.claude/worktrees/') && p.endsWith('/')).map(p => p.slice('.claude/worktrees/'.length, -1))
  // The local branches, so a merged item's branch is listed as `branch:<name>` for the caller's `git branch -D`; none when git fails.
  let branches: string[] = []
  try {
    const r = await h.process.run(['git', '-C', found, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { cwd: found, timeoutMs: 30_000 })
    if (r.exitCode === 0) branches = r.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  } catch {}
  const ledgerBranches: Record<string, string> = {}
  for (const item of b?.items ?? []) {
    if (item.status !== 'merged' || (typeof item.branch === 'string' && item.branch)) continue
    const branch = (await loadLedger(h, found, item.id))?.branch
    if (typeof branch === 'string' && branch) ledgerBranches[item.id] = branch
  }
  return { listing, planPaths, worktrees, branches, ledgerBranches }
}

/**
 * The items whose PR was merged by hand while their Close never ran: every `review` item, and every `building` item
 * with a `pr`, whose branch tip is on `origin/<mainBranch>` (fetched at most once per minute per session). The git
 * calls run through `h.process.run`; a failed one reads as unknown, not merged. The result is kept for the status
 * block and the panel, which never run git themselves.
 */
export async function checkMerged(h: Host, found: string, c: Config | null, b: Backlog | null): Promise<MergedPending[]> {
  try {
    const ledgers: Record<string, Ledger | null> = {}
    for (const item of b?.items ?? []) {
      if (item.status === 'review' || item.status === 'building') ledgers[item.id] = await loadLedger(h, found, item.id)
    }
    const list = mergeCandidates(b, ledgers)
    if (!list.length) {
      self.mergedPending = []
      return []
    }
    const mainBranch = c?.mainBranch ?? DEFAULTS.mainBranch
    const git: Git = async argv => {
      try {
        const r = await h.process.run(argv, { cwd: found, timeoutMs: 60_000 })
        return { exitCode: r.exitCode }
      } catch {
        return null
      }
    }
    const at = await h.clock.now()
    if (isFetchDue(self.lastFetch, at)) {
      self.lastFetch = at
      await git(fetchArgv(found, mainBranch))
    }
    self.mergedPending = await findMerged(found, list, mainBranch, git)
  } catch {}
  return self.mergedPending
}

/** Writes the backlog and its generated view, refreshes the atom and answers what was written, settled, with its readiness. */
export async function writeBacklog(h: Host, found: string, next: Backlog): Promise<{ backlog: Backlog; readiness: Record<string, Readiness> }> {
  const c = await read(h, config)
  if (isGithub(c)) return writeIssueBacklog(h, found, c, next)
  const p = paths(found)
  // Settling moves items between inbox and ready only, so the judgement holds for the settled backlog too.
  const judged = await judgeAll(h, found, next)
  const settled = settle(next, judged, await nowIso(h))
  await h.fs.write(p.backlog, serialize(settled))
  await h.fs.write(p.backlogMd, renderBacklogMd(settled))
  await update(h, backlog, () => settled)
  await update(h, fileError, () => null)
  return { backlog: settled, readiness: judged }
}

/** A backlog write's one-line answer: the item's id, what changed and its status after the write. */
export async function writeLine(h: Host, found: string, next: Backlog, id: string, what: (state: string) => string): Promise<string> {
  const written = await writeBacklog(h, found, next)
  const item = written.backlog.items.find(i => i.id === id)
  return what(item ? itemState(item, written.readiness) : 'gone')
}

/** Marks every open signal delivered: an answer carried them. */
export async function markDelivered(h: Host): Promise<void> {
  await update(h, signals, list => list.map(s => (s.delivered ? s : { ...s, delivered: true })))
  await heartbeat(h, true)
}

/** The actions that change the backlog or a ledger: each runs alone across every session on the repository. */
export const LOCKED_ACTIONS = new Set(['add', 'update', 'move', 'remove', 'park', 'unpark', 'ledger', 'begin', 'plan', 'brief', 'accept', 'close', 'pr', 'adopt', 'start', 'stop', 'init', 'migrate-apply', 'migrate-github', 'spec', 'question', 'answer'])
export const LOCK_WAIT_MS = 250
export const LOCK_TRIES = 120

export const pause = (h: Host, ms: number) => new Promise<void>(resolve => void h.clock.after(ms, () => resolve()))

/**
 * Runs `work` holding the repository's pipeline lock: a folder under .git that only one `mkdir` can create, so two
 * sessions never read and write the backlog at once. It waits for another holder up to thirty seconds, then takes
 * the lock over (its holder died). Where there is no repository, or no `mkdir`, the work runs unlocked, as before.
 */
export async function withLock<T>(h: Host, found: string, work: () => Promise<T>): Promise<T> {
  if (self.lockDepth > 0 || !self.hasRepo) return work()
  const dir = `${found}/.git/pipeline.lock`
  const make = async (): Promise<'held' | 'busy' | 'none'> => {
    try {
      const r = await h.process.run(['mkdir', dir], { cwd: found, timeoutMs: 10_000 })
      if (r.exitCode === 0) return 'held'
      return (await h.fs.exists(dir)) ? 'busy' : 'none'
    } catch {
      return 'none'
    }
  }
  let state = await make()
  for (let i = 0; state === 'busy' && i < LOCK_TRIES; i++) {
    await pause(h, LOCK_WAIT_MS)
    state = await make()
  }
  if (state === 'busy') {
    // Thirty seconds: no action holds it that long, so its holder is gone.
    try {
      await h.process.run(['rmdir', dir], { cwd: found, timeoutMs: 10_000 })
    } catch {}
    state = await make()
  }
  self.lockDepth++
  try {
    return await work()
  } finally {
    self.lockDepth--
    if (state === 'held') {
      try {
        await h.process.run(['rmdir', dir], { cwd: found, timeoutMs: 10_000 })
      } catch {}
    }
  }
}

export async function runTool(h: Host, e: ToolInput): Promise<string> {
  const isOuter = self.toolDepth === 0
  if (isOuter) self.ghPending = null
  self.toolDepth++
  try {
    let answer: string
    if (LOCKED_ACTIONS.has(e.action) && self.lockDepth === 0) {
      const root = await resolveRoot(h)
      answer = await withLock(h, root, () => runToolNow(h, e))
    } else {
      answer = await runToolNow(h, e)
    }
    return isOuter && LOCKED_ACTIONS.has(e.action) ? withPending(answer, self.ghPending) : answer
  } finally {
    self.toolDepth--
  }
}

/** A writing action's answer with the GitHub updates still pending at the end of its first line. */
export function withPending(answer: string, pending: number | null): string {
  if (!pending) return answer
  const [first = '', ...rest] = answer.split('\n')
  return [`${first} · ${pending} GitHub update${pending === 1 ? '' : 's'} pending`, ...rest].join('\n')
}

/** The refusal of an action the issues make meaningless. */
export const notWithIssues = (action: string) => `${action} does not apply with queue: github: the issues are the queue`

export async function runToolNow(h: Host, e: ToolInput): Promise<string> {
  const found = await resolveRoot(h)
  const { config: c, backlog: loaded, error } = await loadAll(h, found)
  const p = paths(found)

  if (e.action === 'init' && (e.queue === 'github' || isGithub(c))) return initGithub(h, found, c, error)
  if (e.action === 'init') {
    const hasConfig = await h.fs.exists(p.config)
    const hasBacklog = await h.fs.exists(p.backlog)
    if (hasConfig && hasBacklog) {
      await ensureIgnore(h, found)
      return `exists: ${CONFIG_FILE}`
    }
    const wrote: string[] = []
    if (!hasConfig) {
      await h.fs.write(p.config, serialize(DEFAULTS))
      await update(h, config, () => structuredClone(DEFAULTS))
      wrote.push(CONFIG_FILE)
    }
    if (!hasBacklog) {
      const empty = emptyBacklog()
      await h.fs.write(p.backlog, serialize(empty))
      await h.fs.write(p.backlogMd, renderBacklogMd(empty))
      await update(h, backlog, () => empty)
      wrote.push(BACKLOG_FILE, BACKLOG_MD_FILE)
    }
    if (!(await h.fs.exists(p.principles))) {
      await h.fs.write(p.principles, PRINCIPLES_STARTER)
      wrote.push(PRINCIPLES_FILE)
    }
    await ensureIgnore(h, found)
    await update(h, fileError, () => null)
    return `wrote ${wrote.join(', ')}\n${commitLine(c?.mainBranch ?? DEFAULTS.mainBranch)}`
  }
  if (e.action === 'status') {
    if (e.id === undefined) return statusNow(h, found, c, loaded, error)
    const item = loaded?.items.find(i => i.id === e.id) ?? null
    if (!item) return `no item ${e.id}`
    const ledger = await readLedger(h, found, item.id)
    if (ledger.error) return `${[item.id, item.title, item.status].join(' · ')}\n${ledger.error}`
    return ledger.value ? ledgerText((await loadLedger(h, found, item.id)) ?? ledger.value, item) : `${[item.id, item.title, item.status].join(' · ')}\nno ledger`
  }
  if (e.action === 'get') {
    const r = loaded ? await judgeAll(h, found, loaded) : {}
    const open = (await read(h, signals)).filter(s => !s.delivered)
    // The active item is the one in planning, building or review; resume is null until its ledger has the block.
    const active = await activeItem(h, loaded)
    const ledger = active ? await loadLedger(h, found, active.id) : null
    // A child's record without its log (up to 200 KB each): `log { item }` answers the text.
    const kids = (await read(h, children)).map(({ log: _log, ...rest }) => rest)
    // A PR merged by hand: the item's Close is pending, and the run skill does it first.
    const merged = await checkMerged(h, found, c, loaded)
    let answer: string
    if (e.full) {
      const out: Record<string, unknown> = { config: isGithub(c) ? githubConfig(c) : c, backlog: loaded, readiness: r, active: active?.id ?? null, resume: ledger?.resume ?? null, signals: open, children: kids, siblings: await read(h, siblings), mergedPending: merged }
      if (error) out['error'] = error
      if (isGithub(c)) Object.assign(out, githubGet(c, e.id))
      answer = JSON.stringify(out, null, 2)
    } else {
      const out: Record<string, unknown> = slimGet({ config: c ? normalizeConfig(c).config : null, backlog: loaded, readiness: r, active, ledger, signals: open, children: kids, siblings: await read(h, siblings) })
      if (e.id !== undefined) {
        const one = loaded?.items.find(i => i.id === e.id) ?? null
        out['item'] = one ? { ...one, ...(r[one.id] ? { readiness: r[one.id] } : {}) } : null
      }
      if (e.titles) out['titles'] = (loaded?.items ?? []).map(i => `${i.id} ${i.status} ${i.title}`)
      if (merged.length) out['mergedPending'] = merged
      if (error) out['error'] = error
      if (isGithub(c)) Object.assign(out, githubGet(c, e.id))
      answer = JSON.stringify(out)
    }
    // Each signal is delivered once: what this answer carries is marked.
    if (open.length) await markDelivered(h)
    return answer
  }
  if (e.action === 'signals') {
    const open = (await read(h, signals)).filter(s => !s.delivered)
    const merged = await checkMerged(h, found, c, loaded)
    const lost = isGithub(c) ? lostLines(c) : []
    if (lost.length) {
      if (open.length) await markDelivered(h)
      return JSON.stringify({ signals: open.map(compactSignal), lost, ...(merged.length ? { mergedPending: merged } : {}) })
    }
    if (!open.length && !merged.length) return 'no signals'
    const answer = merged.length ? JSON.stringify({ signals: open.map(compactSignal), mergedPending: merged }) : JSON.stringify(open.map(compactSignal))
    if (open.length) await markDelivered(h)
    return answer
  }
  if (e.action === 'clean') {
    if (error) throw new Refused(error)
    const id = typeof e.item === 'string' ? e.item : e.item?.id ?? e.id
    // queue: github: what a close had to leave, for a closed issue the backlog no longer holds.
    const left = isGithub(c) ? await leftoverLines(h, found, id) : []
    if (id !== undefined && !left.length) {
      const item = loaded?.items.find(i => i.id === id)
      if (!item) throw new Refused(`no item ${id}`)
      if (item.status !== 'merged') throw new Refused(`${id} is ${item.status}, not merged`)
    }
    const listed = cleanList({ config: c, backlog: loaded, ...(id !== undefined ? { item: id } : {}), ...(isGithub(c) ? { queue: 'github' as const } : {}), ...(await cleanInput(h, found, loaded)) })
    const list = [...listed, ...left.filter(x => !listed.includes(x))]
    return list.length ? list.join('\n') : 'nothing to clean'
  }
  if (e.action === 'migrate') {
    if (!e.refresh && (await h.fs.exists(p.config))) throw new Refused(`${CONFIG_FILE} exists; pass refresh: true to draft again`)
    return JSON.stringify(await migrateDraft(h, found), null, 2)
  }
  if (e.action === 'migrate-apply') {
    if (!e.refresh && (await h.fs.exists(p.dir))) throw new Refused('docs/pipeline/ exists; pass refresh: true to refresh titles, sources and links without changing a status')
    if (error) throw new Refused(error)
    return migrateApply(h, found, loaded, e)
  }
  if (e.action === 'migrate-github') return migrateGithub(h, found, c, loaded, error, e)

  if (e.action === 'log') {
    const id = typeof e.item === 'string' ? e.item : e.item?.id ?? e.id
    if (!id) throw new Refused('an id is needed')
    const child = (await read(h, children)).find(ch => ch.item === id)
    const log = child?.log || (await readText(h, childLog(found, id))) || ''
    return log ? tail(log) : `no log for ${id}`
  }

  // Every write: the file as it is on disk, or refused when it does not parse.
  if (error) throw new Refused(error)
  const current = loaded ?? emptyBacklog()
  const now = await nowIso(h)
  const need = (id: string | undefined): string => {
    if (!id) throw new Refused('an id is needed')
    if (!current.items.some(i => i.id === id)) throw new Refused(`no item ${id}`)
    return id
  }
  switch (e.action) {
    case 'ledger': {
      const named = typeof e.item === 'string' ? e.item : e.item?.id
      // With the issues as the queue a merged item's issue is closed and no longer listed, but its ledger is still
      // on disk: a record written after the merge (what was deployed, what was checked) goes into it.
      const isClosed = Boolean(named) && isGithub(c) && /^\d+$/.test(named!) && !current.items.some(i => i.id === named) && Boolean((await readLedger(h, found, named!)).value)
      const id = isClosed ? named! : need(named)
      const set = e.set as LedgerSet | undefined
      if (!set || typeof set !== 'object' || Array.isArray(set)) throw new Refused('ledger needs set')
      const ledgerPath = placesOf(found, c).ledger(id)
      const ledgerFile = relOf(found, ledgerPath)
      const onDisk = await readLedger(h, found, id)
      if (onDisk.error) throw new Refused(onDisk.error)
      // A ledger file the item does not link is a leftover of a removed item: never merged into silently.
      const linked = current.items.find(i => i.id === id)?.ledger
      // With queue: github an issue number is never used twice and the link of an item not yet in flight is not kept,
      // so a ledger on disk under this id is this item's own: it is taken, never a dead end.
      if (onDisk.value && (linked === null || linked === undefined) && !isGithub(c)) {
        throw new Refused(`${ledgerFile} exists but ${id} has no ledger link: a stale file of an earlier item; move or delete it, or link it with update { id: "${id}", set: { ledger: "${ledgerFile}" } }`)
      }
      // A wrong shape is refused before anything is written; what was plainly meant (text for the resume state) is kept.
      const base = onDisk.value ?? emptyLedger(id)
      const shaped = shapeSet(set as Record<string, unknown>, { resume: repairResume(base.resume, Math.max(1, base.tasks?.length ?? 1)), tasks: base.tasks ?? [] })
      if (shaped.problems.length) throw new Refused(`ledger ${id} not written: ${shaped.problems.join('; ')}`)
      const merged = mergeLedger({ ...base, ...(base.resume ? { resume: repairResume(base.resume, Math.max(1, base.tasks?.length ?? 1))! } : {}) }, shaped.set, now)
      await h.fs.write(ledgerPath, serialize(merged))
      self.memo.delete(`ledger:${id}`)
      if (isClosed) return `${ledgerLine(merged)} · the issue is closed: kept in the ledger only`
      // The item points at its ledger, and carries the branch, PR and plan the ledger names.
      const item = current.items.find(i => i.id === id)!
      const mirror: Partial<Item> = {}
      if (item.ledger !== ledgerFile) mirror.ledger = ledgerFile
      for (const k of ['branch', 'pr', 'plan'] as const) if (typeof set[k] === 'string' && item[k] !== set[k]) mirror[k] = set[k] as string
      if (Object.keys(mirror).length) await writeBacklog(h, found, updateItem(current, id, mirror, now))
      return ledgerLine(merged)
    }
    case 'begin': {
      // With no item named: the first ready one, picked under the lock, so the lead needs no `get` first.
      const named = typeof e.item === 'string' ? e.item : e.item?.id ?? e.id
      const first = named ?? current.items.find(i => i.status === 'ready')?.id
      if (!first) throw new Refused('nothing is ready: every item waits for a spec, an answer or another item')
      return beginAction(h, found, c, current, need(first), e)
    }
    case 'ship':
      return shipAction(h, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'pr':
      return prAction(h, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'accept':
      return acceptAction(h, found, c, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'close': {
      const id = typeof e.item === 'string' ? e.item : e.item?.id ?? e.id
      // With the issues as the queue a closed item is no longer listed: a second close is answered, not refused.
      if (id && isGithub(c) && /^\d+$/.test(id) && !current.items.some(i => i.id === id)) {
        const left = (await extrasOrRefuse(h, found)).leftover?.find(l => l.id === id)
        return `${id} is already closed${left ? ` · its worktree ${left.worktree} is removed by the next begin or /pipeline clean` : ''} · nothing to do`
      }
      return closeAction(h, found, c, current, need(id), e)
    }
    case 'gate':
      return gateAction(h, found, c, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'merge':
      return mergeAction(h, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'plan':
      return planAction(h, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'brief':
      return briefAction(h, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e)
    case 'add': {
      if (isGithub(c)) {
        const added = await addIssue(h, found, c, e)
        const n = /^added (\d+)/.exec(added)?.[1]
        // What add said about the milestone stays on the answer when the spec's line replaces the state.
        const milestone = / · milestone .*$/.exec(added)?.[0] ?? ''
        if (n && typeof e.text === 'string' && e.text.trim()) return `${added.split(' · ')[0]} · ${withoutId(n, await specIssue(h, found, n, e))}${milestone}`
        return added
      }
      const title = typeof e.item === 'string' ? undefined : e.item?.title?.trim()
      if (!title) throw new Refused('add needs item.title')
      let next = addItem(current, { ...(e.item as Partial<Item>), title }, now)
      const id = next.items[next.items.length - 1]!.id
      // The spec given with the item is written and linked in the same call.
      if (typeof e.text === 'string' && e.text.trim()) {
        const rel = `docs/pipeline/specs/${id}.md`
        await h.fs.write(`${found}/${rel}`, e.text.endsWith('\n') ? e.text : `${e.text}\n`)
        next = updateItem(next, id, { spec: rel }, now)
      }
      return writeLine(h, found, next, id, state => `added ${id} · ${state}`)
    }
    case 'update': {
      const id = need(e.id)
      if (!e.set || typeof e.set !== 'object') throw new Refused('update needs set')
      // Under queue github the title, the body, the dependencies and the milestone are the issue's own.
      const TEXT = ['title', 'body', 'needs', 'milestone']
      let said: string[] = []
      let fields = e.set as Record<string, unknown>
      if (isGithub(c) && TEXT.some(k => k in fields)) {
        said = await editIssueText(h, found, id, fields)
        fields = Object.fromEntries(Object.entries(fields).filter(([k]) => !TEXT.includes(k)))
        if (!Object.keys(fields).length) return `${id} · ${await issueState(h, found, id, 'updated')} · set ${said.join(', ')}`
      }
      const before = current.items.find(i => i.id === id)
      const next = updateItem(current, id, fields as Partial<Item>, now)
      const others = [...said, ...Object.keys(fields).filter(k => k !== 'status')]
      const out = await writeLine(h, found, next, id, state => [id, state, ...(others.length ? [`set ${others.join(', ')}`] : [])].join(' · '))
      const after = next.items.find(i => i.id === id)
      if (before && after && startsRun(before.status, after.status)) {
        await queueRename(h, c, after)
        // Direct mode dispatches no agents, so the start of a run is what opens the panel.
        await h.ui.reveal('run')
      }
      return out
    }
    case 'move': {
      if (isGithub(c)) throw new Refused(notWithIssues('move'))
      const id = need(e.id)
      const to = e.to
      if (to !== 'top' && !(to && typeof to === 'object' && typeof to.after === 'string')) throw new Refused('move needs to: "top" or { after: "<id>" }')
      if (to !== 'top') need(to.after)
      return writeLine(h, found, moveItem(current, id, to), id, state => `${id} · moved ${to === 'top' ? 'to the top' : `after ${to.after}`} · ${state}`)
    }
    case 'start':
      return startChild(h, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id), e.force === true)
    case 'stop':
      return stopChild(h, found, c, current, need(typeof e.item === 'string' ? e.item : e.item?.id ?? e.id))
    case 'adopt':
      return adoptAction(h, found, c, current, e)
    case 'remove': {
      if (isGithub(c)) return declineIssue(h, found, c, current, need(e.id), e)
      const id = need(e.id)
      const left = (await writeBacklog(h, found, removeItem(current, id))).backlog.items.length
      return `removed ${id} · ${left} item${left === 1 ? '' : 's'} left`
    }
    case 'park': {
      const id = need(e.id)
      return writeLine(h, found, updateItem(current, id, { status: 'parked' }, now), id, state => `${id} · ${state}`)
    }
    case 'unpark': {
      if (isGithub(c)) return unparkIssue(h, found, c, current, e.id)
      const id = need(e.id)
      return writeLine(h, found, updateItem(current, id, { status: 'inbox' }, now), id, state => `${id} · ${state}`)
    }
    case 'spec':
    case 'question':
    case 'answer': {
      if (!isGithub(c)) throw new Refused(`${e.action} is for queue: github; with queue: file the spec is a file and a question its Open section`)
      const id = need(e.id)
      return e.action === 'spec' ? specIssue(h, found, id, e) : e.action === 'question' ? questionIssue(h, found, c, id, e) : answerIssue(h, found, c, id, e)
    }
    default:
      throw new Refused(`unknown action "${String(e.action)}"`)
  }
}

/** The keys `get` adds with queue: github: how old the issues are when gh failed, the issues that lost the label, the quoted issue. */
export function githubGet(c: Config | null, id: string | undefined): Record<string, unknown> {
  const q = self.queue
  const out: Record<string, unknown> = {}
  if (q?.stale) out['stale'] = q.stale
  const lost = lostLines(c)
  if (lost.length) out['lost'] = lost
  const issue = id !== undefined ? q?.issues.find(i => String(i.number) === id) : undefined
  if (issue) out['quoted'] = quoted(issue, q!.me)
  return out
}

/**
 * The config as `get` answers it with queue: github: an afterMerge entry under docs/pipeline/ has nothing to act on
 * (no BACKLOG.md, no record on mainBranch), so it is left out; pushMain and retain are not read in this mode.
 */
export function githubConfig(c: Config | null): Config | null {
  if (!c) return c
  const recordsDir = `${places('', 'file').recordsDir}/`
  return { ...c, afterMerge: normalizeConfig(c).config.afterMerge.filter(x => !x.replace(/^\.?\/+/, '').startsWith(recordsDir)) }
}

/** `<id> lost the <label> label` for each issue in flight that is open without the queue label. */
export const lostLines = (c: Config | null): string[] => (self.queue?.lost ?? []).map(id => `${id} lost the ${labelOf(c)} label`)
