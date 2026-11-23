// The watchdog and the live file: who is running, who went silent, and the wake-up that checks.
import { read, update } from './state'
import type { Host } from './host'
import type { AgentRun, Backlog, Config, Item, Live, LiveEntry, Signal } from '../types'
import { updateItem } from './backlog'
import { DEFAULTS } from './config'
import { hashRoot, livePath, serialize } from './files'
import { parseLive, siblingsOf, withEntry, withoutEntry } from './live'
import { childSignals, runningOf } from './runner'
import { STALE_MS, deadAgents, mergeSignals, signals as raiseSignals } from './watch'
import { isGithub } from './github'
import { ACTIVE_STATUSES, HEARTBEAT_MS, TICK_MS, WAKE_PROMPT, agents, backlog, children, config, loadAll, now, resolveRoot, root, self, siblings, signals, slashes } from './shared'
import { runTool, writeBacklog } from './tool'

/** The limits in force: the config's over the defaults, so a partial config still has every number. */
export function limitsOf(c: Config | null): Config['limits'] {
  const given = c && typeof c.limits === 'object' && c.limits ? c.limits : {}
  const out = { ...DEFAULTS.limits }
  for (const k of Object.keys(out) as (keyof Config['limits'])[]) {
    const v = (given as Partial<Config['limits']>)[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
  }
  return out
}

export const protectedOf = (c: Config | null): string[] => (Array.isArray(c?.protectedPaths) ? c.protectedPaths.filter((g): g is string => typeof g === 'string' && g !== '') : DEFAULTS.protectedPaths)

export async function homeDir(h: Host): Promise<string> {
  // `h.env.get` takes a literal name, so the module's reads can be listed.
  let v: string | undefined
  try {
    v = (await h.env.get('HOME')) || (await h.env.get('USERPROFILE'))
  } catch {}
  return v ? slashes(v) : ''
}

export async function liveFile(h: Host): Promise<string> {
  const found = (await read(h, root)) || (await resolveRoot(h))
  return livePath(found, self.hasRepo, self.hasRepo ? '' : await homeDir(h), self.hasRepo ? '' : await hashRoot(found))
}

export async function readText(h: Host, path: string): Promise<string | null> {
  try {
    if (!(await h.fs.exists(path))) return null
    const t = await h.fs.read(path)
    return typeof t === 'string' ? t : null
  } catch {
    return null
  }
}

/** The branch the session's own checkout is on: `.git` is a folder in a main checkout, a `gitdir:` file in a worktree. */
export async function branchOf(h: Host): Promise<string | undefined> {
  try {
    const top = self.sessionRoot || slashes(await h.session.root())
    const pointer = await readText(h, `${top}/.git`)
    const gitDir = pointer?.startsWith('gitdir:') ? slashes(pointer.slice(7).trim()) : `${top}/.git`
    const head = await readText(h, `${gitDir}/HEAD`)
    return /^ref: refs\/heads\/(.+?)\s*$/m.exec(head ?? '')?.[1]
  } catch {
    return undefined
  }
}

/**
 * The active item of this session, with several sessions on one repository each running their own: the item this
 * session last worked on through the tool; else the one whose worktree or branch this session is in; else one a
 * child of this session runs; else the first active item no other live session claims and, with queue: github, this
 * machine has a record of. Null when every active item is another session's or another machine's.
 */
export async function activeItem(h: Host, b: Backlog | null): Promise<Item | null> {
  const actives = (b?.items ?? []).filter(i => (ACTIVE_STATUSES as readonly string[]).includes(i.status))
  if (!actives.length) return null
  const mine = actives.find(i => i.id === self.item)
  if (mine) return mine
  try {
    const name = /\/\.claude\/worktrees\/([^/]+)/.exec(`${slashes(await h.session.cwd())}/`)?.[1]
    const inTree = name ? actives.find(i => i.id === name) : undefined
    if (inTree) return inTree
  } catch {}
  const branch = await branchOf(h)
  const onBranch = branch ? actives.find(i => i.branch === branch) : undefined
  if (onBranch) return onBranch
  const kids = new Set((await read(h, children)).map(ch => ch.item))
  const ofChild = actives.find(i => kids.has(i.id))
  if (ofChild) return ofChild
  const claimed = new Set((await read(h, siblings)).filter(x => !x.isStale && x.item).map(x => x.item))
  // With the issues as the queue the building label travels and the record does not: an item in flight that has
  // no branch and no ledger here was begun on another machine, and is not this session's to resume.
  const isElsewhere = isGithub(await read(h, config)) ? (i: Item) => !i.branch && !i.ledger : () => false
  return actives.find(i => !claimed.has(i.id) && !isElsewhere(i)) ?? null
}

/** This session's live entry: the active item, the running agents and every signal of this session. */
export async function entryOf(h: Host, previous: LiveEntry | undefined, at: number): Promise<LiveEntry> {
  const nowIso = new Date(at).toISOString()
  if (!self.startedAt) self.startedAt = nowIso
  const active = await activeItem(h, await read(h, backlog))
  // An item a child session runs, or ran, is the child's: its own entry names it, and a child that exited with the
  // item still building leaves it to the dead signal, not to this session's entry.
  const owned = new Set((await read(h, children)).map(ch => ch.item))
  const item = active && !owned.has(active.id) ? active : null
  const running = (await read(h, agents)).filter(a => a.status === 'running')
  let cwd = ''
  try {
    cwd = slashes(await h.session.cwd())
  } catch {}
  const branch = await branchOf(h)
  const title = item ? `${item.id} · ${item.title}` : cwd.split('/').pop() || 'pipeline'
  // Unknown fields of the entry on disk survive; branch and item are this write's.
  const { branch: _b, item: _i, ...kept } = previous ?? {}
  return {
    ...kept,
    title,
    cwd,
    ...(branch ? { branch } : {}),
    ...(item ? { item: item.id } : {}),
    startedAt: self.startedAt,
    seenAt: nowIso,
    agents: running,
    signals: await read(h, signals),
  }
}

/**
 * Writes this session's entry after a fresh read of the file, throttled to one write per 2 s unless forced.
 * Every file this module writes (the live file, the backlog, a ledger, the config) goes through a direct
 * `h.fs.write`: the API has no rename, so a write-to-temp-then-rename is not available; the reads parse
 * defensively instead, and a file that does not parse is refused and left alone.
 */
export async function heartbeat(h: Host, isForced = false): Promise<void> {
  try {
    const at = await h.clock.now()
    if (!isForced && at - self.lastWrite < HEARTBEAT_MS) return
    self.lastWrite = at
    const path = await liveFile(h)
    const id = await h.session.id()
    const current = parseLive((await readText(h, path)) ?? '')
    await h.fs.write(path, serialize(withEntry(current, id, await entryOf(h, current.sessions[id], at), at)))
    await refreshSiblings(h, current, id, at)
  } catch {}
}

/**
 * The other sessions of the live file into the atom: the children this session runs are left out, and so is an
 * entry in this session's own cwd or root, which is this session's under an earlier id (after a /clear or a resume
 * the process goes on under a new id without a session.start).
 */
export async function refreshSiblings(h: Host, current: Live, id: string, at: number): Promise<void> {
  const own = (await read(h, children)).map(ch => ch.id)
  const cwds: string[] = []
  for (const get of [() => h.session.cwd(), () => h.session.root()]) {
    try {
      cwds.push(slashes(await get()))
    } catch {}
  }
  await update(h, siblings, () => siblingsOf(current, id, at, own, cwds))
}

/** A signal to the person, per `config.notify`: a push notification, or a toast when the push is refused. */
export async function notify(h: Host, c: Config | null, list: Signal[]): Promise<void> {
  const mode = c?.notify ?? DEFAULTS.notify
  if (mode === 'off') return
  for (const s of list) await announce(h, c, `pipeline: ${s.kind} · ${s.agent} · ${s.detail}`)
}

/** One message to the person: a push notification, or a toast when the push is refused; nothing with notify off. */
export async function announce(h: Host, c: Config | null, text: string): Promise<void> {
  if ((c?.notify ?? DEFAULTS.notify) === 'off') return
  const message = text.slice(0, 200)
  let isSent = false
  try {
    const r = await h.tool.call({ tool: 'PushNotification', message, status: 'proactive' })
    isSent = !(r && typeof r === 'object' && 'deny' in r && r.deny !== undefined)
  } catch {}
  if (!isSent) {
    try {
      await h.ui.toast(message)
    } catch {}
  }
}

/**
 * Every 30 s: the signals due now join the atom and reach the person; an entry of another session that went
 * stale since this session started (it died under STALE_MS before our start, say) gives its dead signals now,
 * and is dropped from the file so it is reported once; the live file is refreshed.
 */
export async function tick(h: Host): Promise<void> {
  try {
    const at = await h.clock.now()
    let c = await read(h, config)
    const kids = await read(h, children)
    // Other sessions (the children, a sibling) write the backlog too: with the session runner the files are re-read.
    if (kids.length || c?.runner === 'session') {
      const found = (await read(h, root)) || (await resolveRoot(h))
      c = (await loadAll(h, found)).config
    }
    const fresh = raiseSignals(await read(h, agents), limitsOf(c), at, await read(h, signals))
    if (fresh.length) {
      await update(h, signals, list => [...list, ...fresh])
      await notify(h, c, fresh)
    }
    if (kids.length) {
      const path = await liveFile(h)
      const live = parseLive((await readText(h, path)) ?? '')
      const before = await read(h, signals)
      const added = mergeSignals(before, childSignals({ children: kids, live, items: (await read(h, backlog))?.items ?? [], now: at, staleMs: STALE_MS })).slice(before.length)
      if (added.length) {
        await update(h, signals, list => mergeSignals(list, added))
        await notify(h, c, added)
      }
    }
    await reportGone(h, at, c)
    await update(h, now, () => at)
    await heartbeat(h, true)
  } catch {}
}

/** The gone entries of other sessions in the live file: their signals restored and their agents dead, then dropped. */
export async function reportGone(h: Host, at: number, c: Config | null): Promise<void> {
  const path = await liveFile(h)
  const id = await h.session.id()
  const current = parseLive((await readText(h, path)) ?? '')
  // This session's own entry is alive by definition: it is refreshed by the heartbeat right after.
  const dead = deadAgents(withoutEntry(current, id), id, at)
  if (!dead.sessions.length) return
  let pruned = current
  for (const gone of dead.sessions) pruned = withoutEntry(pruned, gone)
  await h.fs.write(path, serialize(pruned))
  const before = await read(h, signals)
  const added = mergeSignals(before, dead.signals).slice(before.length)
  if (!added.length) return
  await update(h, signals, list => mergeSignals(list, added))
  await notify(h, c, added.filter(s => dead.fresh.includes(s)))
}

/**
 * At session start: the undelivered signals of the entries that are gone (this session's id, a restart, or a
 * stale one) come back into the atom, and the agents they list running are dead; then this session's fresh
 * entry, and the ticker.
 */
export async function arrive(h: Host): Promise<void> {
  const at = await h.clock.now()
  const path = await liveFile(h)
  const id = await h.session.id()
  let current = parseLive((await readText(h, path)) ?? '')
  const dead = deadAgents(current, id, at)
  // Nothing that ran before this start is still running.
  await update(h, agents, list => list.map((a): AgentRun => (a.status === 'running' ? { ...a, status: 'failed', endedAt: at } : a)))
  if (dead.sessions.length) {
    // A signal the atom still holds (the state survived) is not doubled; the restored ones stay undelivered.
    const before = await read(h, signals)
    const added = mergeSignals(before, dead.signals).slice(before.length)
    if (added.length) await update(h, signals, list => mergeSignals(list, added))
    for (const gone of dead.sessions) current = withoutEntry(current, gone)
    // The person hears of the dead ones now; a restored signal was announced when it was raised.
    const announced = added.filter(s => dead.fresh.includes(s))
    if (announced.length) await notify(h, await read(h, config), announced)
  }
  try {
    await orphanChildren(h, at)
  } catch {}
  self.startedAt = new Date(at).toISOString()
  self.lastWrite = at
  await h.fs.write(path, serialize(withEntry(current, id, await entryOf(h, undefined, at), at)))
  await refreshSiblings(h, current, id, at)
  self.ticker?.cancel()
  self.ticker = h.clock.every(TICK_MS, () => void tick(h))
}

export const RESTARTED = 'the parent session restarted'

/**
 * The child records of a life before this one (the state survives a hot reload, the processes do not: a child dies
 * with its parent's module): every starting or running record whose item has no process here is failed, its item
 * blocked unless the child got it past the build, and a dead signal is raised once for each.
 */
export async function orphanChildren(h: Host, at: number): Promise<void> {
  const orphans = runningOf(await read(h, children)).filter(ch => !self.procs.has(ch.item))
  if (!orphans.length) return
  const ids = new Set(orphans.map(o => o.id))
  await update(h, children, prev => prev.map(ch => (ids.has(ch.id) ? { ...ch, status: 'failed' as const, endedAt: at, lastLine: RESTARTED } : ch)))
  const found = (await read(h, root)) || (await resolveRoot(h))
  const { config: c, backlog: fresh, error } = await loadAll(h, found)
  const blocked: string[] = []
  if (!error && fresh) {
    let next = fresh
    for (const o of orphans) {
      const item = next.items.find(i => i.id === o.item)
      if (!item || item.status === 'merged' || item.status === 'review') continue
      next = updateItem(next, item.id, { status: 'blocked', note: RESTARTED }, new Date(at).toISOString())
      blocked.push(item.id)
    }
    if (blocked.length) await writeBacklog(h, found, next)
    for (const id of blocked) {
      try {
        await runTool(h, { action: 'ledger', item: id, set: { blockers: [RESTARTED] } })
      } catch {}
    }
  }
  const dead: Signal[] = orphans.map(o => ({ kind: 'dead', agent: `child ${o.item}`, agentId: o.id, detail: `${RESTARTED} while the child session ran${blocked.includes(o.item) ? ` · ${o.item} blocked` : ''} · resume with /pipeline run ${o.item}`, at, delivered: false }))
  const before = await read(h, signals)
  const added = mergeSignals(before, dead).slice(before.length)
  if (!added.length) return
  await update(h, signals, list => mergeSignals(list, added))
  await notify(h, c, added)
}

/** Between items: one wake-up at `silentMinutes` while an agent runs, where the host offers ScheduleWakeup; never two pending. */
export async function scheduleWake(h: Host, at: number): Promise<void> {
  if (at < self.wakeUntil) return
  if (!(await read(h, agents)).some(a => a.status === 'running') && !runningOf(await read(h, children)).length) return
  let isOffered = false
  try {
    isOffered = (await h.tool.list()).some(t => t.name === 'ScheduleWakeup')
  } catch {}
  if (!isOffered) return
  const delaySeconds = limitsOf(await read(h, config)).silentMinutes * 60
  self.wakeUntil = at + delaySeconds * 1000
  try {
    await h.tool.call({ tool: 'ScheduleWakeup', delaySeconds, reason: 'pipeline: a subagent or a child session is running; the watchdog signals are checked at silentMinutes', prompt: WAKE_PROMPT })
  } catch {}
}
