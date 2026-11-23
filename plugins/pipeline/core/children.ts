// The session runner: items built in headless child sessions.
import { read, update } from './state'
import type { Host } from './host'
import type { Backlog, ChildSession, Config } from '../types'
import { updateItem } from './backlog'
import { DEFAULTS } from './config'
import { ALLOWED_MODES, appendOutput, branchOf as itemBranchOf, childArgv, childPrompt, exitNote, runningOf, withExit, withStopped, worktreeOf } from './runner'
import { sessionName } from './status'
import { claimIssue, isGithub } from './github'
import { LOG_WRITE_MS, childLog, children, config, loadAll, self } from './shared'
import { Refused, loadLedger, runTool, writeBacklog } from './tool'
import { announce, heartbeat, limitsOf } from './watchdog'

/** The variable a child session is started with; a session that sees it starts no children. */
export const CHILD_MARK = 'PIPELINE_CHILD'

/** Whether this session was started by the session runner: the mark is in its environment. */
export async function isChildSession(h: Host): Promise<boolean> {
  try {
    return Boolean(await h.env.get('PIPELINE_CHILD'))
  } catch {
    return false
  }
}

/** The session's permission mode: the one the engine last told us, else the settings' default mode, else `default`. */
export async function permissionModeOf(h: Host): Promise<string> {
  if (self.permissionMode) return self.permissionMode
  try {
    const permissions = await h.settings.read({ key: 'permissions' })
    const mode = permissions && typeof permissions === 'object' ? (permissions as { defaultMode?: unknown }).defaultMode : undefined
    if (typeof mode === 'string' && mode) return mode
  } catch {}
  return 'default'
}

/** The item's worktree: made off mainBranch on its branch, reused when it is there, added on the branch alone when the branch exists. */
export async function ensureWorktree(h: Host, found: string, worktree: string, branch: string, mainBranch: string): Promise<void> {
  try {
    if (await h.fs.exists(worktree)) return
  } catch {}
  const add = async (argv: string[]) => {
    try {
      return await h.process.run(argv, { cwd: found, timeoutMs: 120_000 })
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  }
  let r = await add(['git', 'worktree', 'add', worktree, '-b', branch, mainBranch])
  if (r.exitCode !== 0 && /already exists/i.test(r.stderr)) r = await add(['git', 'worktree', 'add', worktree, branch])
  if (r.exitCode !== 0) throw new Refused(`git worktree add failed: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}`)
}

export const list = (xs: readonly string[]) => `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`

/** `start`: the checks, the worktree, the item marked building, the ledger's branch and worktree, the child spawned and its loop detached. */
export async function startChild(h: Host, found: string, c: Config | null, current: Backlog, id: string, force = false): Promise<string> {
  // The mechanical guard against recursion: a child is started with PIPELINE_CHILD set, and never starts children.
  if (await isChildSession(h)) throw new Refused('a child session does not start children')
  const runner = c?.runner ?? DEFAULTS.runner
  if (runner !== 'session') throw new Refused(`runner is ${runner}; set it with /pipeline config runner=session`)
  const item = current.items.find(i => i.id === id)!
  const running = runningOf(await read(h, children))
  const own = running.find(ch => ch.item === id)
  if (own) throw new Refused(`${id} already runs in session ${own.id}`)
  if (item.status !== 'ready' && item.status !== 'blocked' && item.status !== 'building') throw new Refused(`${id} is ${item.status}, not ready`)
  // queue: github: the claim begin checks, so the child's begin does not pass on the ledger written here.
  const hasLedger = isGithub(c) && (await loadLedger(h, found, id)) !== null
  if (isGithub(c)) await claimIssue(h, found, c, id, hasLedger, force)
  // A building item the session runner did not start is being run in a session, this one or another: not taken over.
  // With queue: github and no ledger here, a forced start takes over another machine's run, as begin does.
  const isTakeover = isGithub(c) && force && !hasLedger
  if (item.status === 'building' && !isTakeover && !/session runner/.test(item.note ?? '')) throw new Refused(`${id} is being run in-session (building, note: ${item.note || 'none'}); finish or stop that run, or block the item, before starting it as a child session`)
  const mode = await permissionModeOf(h)
  if (!(ALLOWED_MODES as readonly string[]).includes(mode)) {
    throw new Refused(`the session's permission mode is ${mode}; a headless child cannot ask, so switch to ${list(ALLOWED_MODES)} (Shift+Tab) and start again`)
  }
  const parallel = limitsOf(c).parallel
  if (running.length >= parallel) throw new Refused(`${running.length} child session${running.length === 1 ? '' : 's'} running; limits.parallel is ${parallel}`)
  const worktree = worktreeOf(found, id)
  const branch = itemBranchOf(c?.branch ?? DEFAULTS.branch, id)
  await ensureWorktree(h, found, worktree, branch, c?.mainBranch ?? DEFAULTS.mainBranch)
  const at = await h.clock.now()
  const sessionId = crypto.randomUUID()
  const isResume = item.status !== 'ready'
  const note = item.status === 'blocked' && item.note ? `session runner · was blocked: ${item.note}` : 'session runner'
  await writeBacklog(h, found, updateItem(current, id, { status: 'building', note }, new Date(at).toISOString()))
  try {
    await runTool(h, { action: 'ledger', item: id, set: { branch, worktree: `.claude/worktrees/${id}` } })
  } catch {}
  const child: ChildSession = { id: sessionId, item: id, worktree, branch, status: 'starting', startedAt: at, log: '' }
  await update(h, children, prev => [...prev.filter(ch => ch.item !== id), child])
  const argv = childArgv({ prompt: childPrompt(id, { isResume }), permissionMode: mode, sessionId, ...((c?.renameSession ?? DEFAULTS.renameSession) !== false ? { name: sessionName(item) } : {}) })
  // `env` is set over the host's environment, so the child inherits the rest and sees the mark.
  void runChild(h, found, child, { argv, cwd: worktree, env: { [CHILD_MARK]: '1' } })
  await heartbeat(h, true)
  return `started ${id} in .claude/worktrees/${id} · session ${sessionId} · log .git/pipeline/${id}.log`
}

/** The child's life: its output into the record and the log file, piece by piece, then its end. */
export async function runChild(h: Host, found: string, child: ChildSession, request: { argv: string[]; cwd: string; env: Record<string, string> }): Promise<void> {
  const logPath = childLog(found, child.item)
  const proc = { stream: null as null | AsyncGenerator<{ stream: string; text: string }, { code: number | null; signal: string | null }>, partial: '', lastWrite: -Infinity }
  self.procs.set(child.item, proc)
  let end: { code: number | null; signal: string | null } = { code: null, signal: 'SIGTERM' }
  try {
    const stream = h.process.spawn(request)
    proc.stream = stream
    for (;;) {
      const r = await stream.next()
      if (r.done) {
        if (r.value) end = r.value
        break
      }
      const at = await h.clock.now()
      const before = (await read(h, children)).find(ch => ch.id === child.id)
      if (!before) break
      const { child: next, partial } = appendOutput(before, r.value.text, proc.partial)
      proc.partial = partial
      const after = { ...next, status: next.status === 'starting' ? ('running' as const) : next.status }
      await update(h, children, prev => prev.map(ch => (ch.id === child.id ? after : ch)))
      if (at - proc.lastWrite >= LOG_WRITE_MS) {
        proc.lastWrite = at
        try {
          await h.fs.write(logPath, after.log)
        } catch {}
      }
    }
  } catch (err) {
    // The child could not start, or the stream failed: the record says so and the item is blocked below.
    end = { code: 1, signal: null }
    const message = `could not run the child: ${err instanceof Error ? err.message : String(err)}`
    await update(h, children, prev => prev.map(ch => (ch.id === child.id ? { ...ch, log: `${ch.log}${message}\n`, lastLine: message } : ch))).catch(() => {})
  } finally {
    // Only this child's own entry: the item may have been started again while this process was still ending.
    if (self.procs.get(child.item) === proc) self.procs.delete(child.item)
  }
  try {
    await finishChild(h, found, child.id, end, proc.partial, logPath)
  } catch {}
}

/** The child ended: the record closed, the log flushed, a failed exit blocks the item, the person hears of it. */
export async function finishChild(h: Host, found: string, id: string, end: { code: number | null; signal: string | null }, partial: string, logPath: string): Promise<void> {
  const at = await h.clock.now()
  const before = (await read(h, children)).find(ch => ch.id === id)
  if (!before) return
  const flushed = partial.trim() ? appendOutput(before, '\n', partial).child : before
  const after = withExit(flushed, end, at)
  await update(h, children, prev => prev.map(ch => (ch.id === id ? after : ch)))
  try {
    await h.fs.write(logPath, after.log)
  } catch {}
  const c = await read(h, config)
  // Stopped by the person: the item was blocked then. Failed: blocked now, unless the child got it past the build.
  if (before.status !== 'stopped' && after.status === 'failed') {
    const { backlog: fresh, error } = await loadAll(h, found)
    const item = fresh?.items.find(i => i.id === after.item)
    if (!error && fresh && item && item.status !== 'merged' && item.status !== 'review') {
      await writeBacklog(h, found, updateItem(fresh, item.id, { status: 'blocked', note: exitNote(after, end) }, new Date(at).toISOString()))
      try {
        await runTool(h, { action: 'ledger', item: item.id, set: { blockers: [exitNote(after, end)] } })
      } catch {}
    }
  }
  if (before.status !== 'stopped') await announce(h, c, `pipeline: child ${after.item} ${after.status}${after.lastLine ? ` · ${after.lastLine}` : ''}`)
  await heartbeat(h, true)
}

/** `stop`: the child's stream closed, which kills it; the record stopped; the item blocked unless it is past the build. */
export async function stopChild(h: Host, found: string, c: Config | null, current: Backlog, id: string): Promise<string> {
  const child = runningOf(await read(h, children)).find(ch => ch.item === id)
  if (!child) throw new Refused(`no child session runs ${id}`)
  const at = await h.clock.now()
  await update(h, children, prev => prev.map(ch => (ch.id === child.id ? withStopped(ch, at) : ch)))
  const proc = self.procs.get(id)
  // Not awaited: the engine kills the child when the loop is left, and the loop's own end closes the record.
  if (proc?.stream) void proc.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
  const item = current.items.find(i => i.id === id)
  const reason = 'stopped by the user'
  let outcome = ''
  if (item && item.status !== 'merged' && item.status !== 'review') {
    await writeBacklog(h, found, updateItem(current, id, { status: 'blocked', note: reason }, new Date(at).toISOString()))
    try {
      await runTool(h, { action: 'ledger', item: id, set: { blockers: [reason] } })
    } catch {}
    outcome = ` · ${id} blocked: ${reason}`
  } else if (item) outcome = ` · ${id} stays ${item.status}`
  await heartbeat(h, true)
  return `stopped ${id} · session ${child.id}${outcome}`
}
