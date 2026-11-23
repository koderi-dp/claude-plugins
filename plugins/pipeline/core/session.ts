// What the session shows and keeps: its name, its saved transcript, its background commands and the band.
import { read, update } from './state'
import type { Host } from './host'
import type { Config, Item } from '../types'
import { bgEnd, bgReconcile, bgStart, checkPrompt } from './background'
import type { BgSummary } from './background'
import { DEFAULTS } from './config'
import { bandOf, idleLine, sessionName } from './status'
import type { Band } from './status'
import { digest, hasAnswer, indexMd, sessionFolder } from './transcripts'
import type { SessionRecord } from './transcripts'
import type { Call } from './watch'
import { isChildSession } from './children'
import { agents, background, backlog, config, now, opts, resolveRoot, root, self, slashes } from './shared'
import { drawnLedger, runTool } from './tool'
import type { ToolInput } from './tool'
import { activeItem, readText } from './watchdog'

/**
 * Queues the session's name after the item it starts (`p12 · CSV export`), once per item in this session, unless
 * `renameSession` is false; a child session is named by its argv from the start and never renames itself. The
 * built-in rename command cannot run from the tool's own hook (it would wait on the turn the hook holds), so the
 * name waits for the turn's end.
 */
export async function queueRename(h: Host, c: Config | null, item: Item): Promise<void> {
  if ((c?.renameSession ?? DEFAULTS.renameSession) === false || self.renamed.has(item.id)) return
  if (await isChildSession(h)) return
  self.renamed.add(item.id)
  self.pendingRename = sessionName(item)
}

/** The queued rename, at the turn's end; a refusal (no such command, a surface without names) is ignored. */
export async function renameNow(h: Host): Promise<void> {
  const name = self.pendingRename
  if (!name) return
  self.pendingRename = ''
  self.sessionName = name
  try {
    await h.command.run({ command: 'rename', args: name })
  } catch {}
}

/**
 * The `transcripts` setting: this session's transcript and those of its subagents are copied into the plugin's
 * data folder, `transcripts/<project>/<date>_<time>_<session>/`, each as the .jsonl and as a page to read, with an
 * `info.json` and the project's `index.md`. Runs at the end of each turn and of the session; a subagent file that
 * did not grow is not copied again. A failure is said once and never stops the session.
 */
export async function saveTranscript(h: Host, endingId?: string): Promise<void> {
  if (!opts.isTranscripts) return
  try {
    const source = slashes((await h.session.info()).transcriptPath ?? '')
    const data = (await h.process.hookEnv())['CLAUDE_PLUGIN_DATA']
    if (!source || !data) return
    const text = await readText(h, source)
    if (text === null) return
    // A session the model never answered in (opened and closed, or waiting for a sign-in) is not worth a folder.
    if (!hasAnswer(text)) return
    const found = (await read(h, root)) || (await resolveRoot(h))
    const project = found.split('/').pop() || 'project'
    const id = endingId || (await h.session.id())
    const at = await h.clock.now()
    const log = self.log
    let earlier: SessionRecord | undefined
    if (log.id !== id) {
      log.id = id
      log.startedAt = at
      log.folder = sessionFolder(data, project, id, at)
      log.sizes = new Map()
      // The same session saved before (the plugin was reloaded or updated, or the session was resumed): its folder
      // is kept, so one session is one folder.
      try {
        const projectDir = log.folder.slice(0, log.folder.lastIndexOf('/'))
        const all = JSON.parse((await readText(h, `${projectDir}/index.json`)) ?? '{}') as Record<string, SessionRecord>
        earlier = Object.values(all).find(r => r.sessionId === id && r.folder)
        if (earlier) {
          log.folder = `${projectDir}/${earlier.folder}`
          log.startedAt = Date.parse(earlier.startedAt) || at
          log.earlier = { name: earlier.name ?? '', items: earlier.items ?? [] }
        }
      } catch {}
    }
    if (!log.version) {
      try {
        const root = (await h.process.hookEnv())['CLAUDE_PLUGIN_ROOT']
        log.version = String((JSON.parse((await readText(h, `${slashes(root ?? '')}/.claude-plugin/plugin.json`)) ?? '{}') as { version?: unknown }).version ?? '')
      } catch {}
    }
    const name = self.sessionName || self.pendingRename || log.earlier.name
    const title = `${project} · ${name || id}`
    await h.fs.write(`${log.folder}/session.jsonl`, text)
    await h.fs.write(`${log.folder}/session.md`, digest(text, title))
    // The subagents' transcripts lie beside the session's, under a folder of its name.
    const dir = `${source.replace(/\.jsonl$/, '')}/subagents`
    let subagents = 0
    try {
      // A session that started no subagent has no such folder: the listing fails and nothing is copied.
      {
        for (const e of await h.fs.list(dir)) {
          if (e.kind !== 'file' || !e.name.endsWith('.jsonl')) continue
          subagents++
          const size = (e as { size?: number }).size ?? -1
          if (size >= 0 && log.sizes.get(e.name) === size) continue
          const t = await readText(h, `${dir}/${e.name}`)
          if (t === null) continue
          await h.fs.write(`${log.folder}/subagents/${e.name}`, t)
          await h.fs.write(`${log.folder}/subagents/${e.name.replace(/\.jsonl$/, '.md')}`, digest(t, `${title} · ${e.name.replace(/\.jsonl$/, '')}`))
          log.sizes.set(e.name, size)
        }
      }
    } catch {}
    const folder = log.folder.split('/').pop() ?? ''
    const record: SessionRecord = {
      folder,
      project,
      cwd: found,
      sessionId: id,
      name,
      items: [...new Set([...log.earlier.items, ...self.renamed])],
      pluginVersion: log.version,
      startedAt: new Date(log.startedAt).toISOString(),
      updatedAt: new Date(at).toISOString(),
      source,
      subagents,
    }
    await h.fs.write(`${log.folder}/info.json`, `${JSON.stringify(record, null, 2)}\n`)
    const projectDir = log.folder.slice(0, log.folder.lastIndexOf('/'))
    let all: Record<string, SessionRecord> = {}
    try {
      all = JSON.parse((await readText(h, `${projectDir}/index.json`)) ?? '{}') as Record<string, SessionRecord>
    } catch {}
    all[folder] = record
    await h.fs.write(`${projectDir}/index.json`, `${JSON.stringify(all, null, 2)}\n`)
    await h.fs.write(`${projectDir}/index.md`, indexMd(project, Object.values(all)))
  } catch (err) {
    if (self.log.hasFailed) return
    self.log.hasFailed = true
    try {
      await h.ui.toast(`pipeline: could not save the transcript: ${err instanceof Error ? err.message : String(err)}`)
    } catch {}
  }
}

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** The list set against what the engine says is still in flight; nothing when it does not say. Never throws. */
export async function reconcileBackground(h: Host, inFlight: unknown): Promise<void> {
  try {
    if (!Array.isArray(inFlight)) return
    const at = await h.clock.now()
    await update(h, background, list => bgReconcile(list, inFlight as BgSummary[], at))
  } catch {}
}

/**
 * After a tool call came back: a shell command that went to the background joins the panel's list with the
 * description its caller gave it, and a task the model stopped itself leaves it. Never throws.
 */
export async function noteBackground(h: Host, tool: string, call: Call, result: unknown, agentId: string | undefined): Promise<void> {
  try {
    const input = call as unknown as Record<string, unknown>
    const out = (result as { result?: unknown } | undefined)?.result
    if (SHELL_TOOLS.has(tool)) {
      const id = out && typeof out === 'object' ? (out as { backgroundTaskId?: unknown }).backgroundTaskId : undefined
      if (typeof id !== 'string' || !id) return
      const owner = agentId ? (await read(h, agents)).find(a => a.agentId === agentId || a.id === agentId)?.name : undefined
      const at = await h.clock.now()
      await update(h, background, list =>
        bgStart(list, { id, description: typeof input['description'] === 'string' ? input['description'] : '', command: String(input['command'] ?? ''), ...(owner ? { owner } : agentId ? { owner: 'a subagent' } : {}), ...(agentId ? { agentId } : {}), at }),
      )
    } else if (tool === 'TaskStop') {
      const id = input['task_id'] ?? input['shell_id']
      if (typeof id === 'string' && id && !(result && typeof result === 'object' && 'deny' in result && (result as { deny?: unknown }).deny !== undefined)) await update(h, background, list => bgEnd(list, id))
    }
  } catch {}
}

/** Stop pressed on a background command: the engine's own stop, its answer as a toast, and the row goes. */
export async function stopBackground(h: Host, id: string): Promise<void> {
  let said: string
  let isGone = false
  try {
    const r = (await h.tool.call({ tool: 'TaskStop', task_id: id })) as { deny?: string; result?: unknown }
    if (r.deny !== undefined) said = `could not stop ${id}: ${r.deny}`
    else {
      isGone = true
      said = `stopped ${id}`
    }
  } catch (err) {
    said = `could not stop ${id}: ${err instanceof Error ? err.message : String(err)}`
  }
  // A task the engine no longer knows has ended already: the row was stale.
  if (!isGone && /not found|no (?:such|running|background) |already|not running|unknown task/i.test(said)) {
    isGone = true
    said = `${id} had already ended`
  }
  try {
    if (isGone) await update(h, background, list => bgEnd(list, id))
    await h.ui.toast(`pipeline: ${said}`)
  } catch {}
}

/** Check pressed on a background command: the session is asked where it stands and to stop it when it is stuck. */
export async function checkBackground(h: Host, id: string): Promise<void> {
  try {
    const task = (await read(h, background)).find(t => t.id === id)
    if (!task) return
    await h.prompt.submit({ text: checkPrompt(task, await h.clock.now()) })
    await h.ui.toast(`pipeline: asked the session to check "${task.what}"; it answers when its current turn ends`)
  } catch (err) {
    try {
      await h.ui.toast(`pipeline: could not ask about ${id}: ${err instanceof Error ? err.message : String(err)}`)
    } catch {}
  }
}

/** A tool action pressed from the panel: its one-line answer as a toast, so the person sees what happened. */
export async function pressTool(h: Host, input: ToolInput): Promise<void> {
  let text: string
  try {
    text = await runTool(h, input)
  } catch (err) {
    text = `refused: ${err instanceof Error ? err.message : String(err)}`
  }
  try {
    await h.ui.toast(`pipeline: ${text.split('\n')[0] ?? ''}`)
  } catch {}
}

/**
 * The idle strip's line when nothing is active in a project with a pipeline (`pipeline · idle · 28 inbox · next: p2
 * Brand logos`); nothing without a config, during a survey, or with `idleStrip: hide`.
 */
export async function idleText(h: Host, hasSurvey: boolean | undefined): Promise<string> {
  try {
    if (!opts.isIdleStrip || hasSurvey || !(await read(h, config))) return ''
    return `pipeline · ${idleLine((await read(h, backlog))?.items ?? [])}`
  } catch {
    return ''
  }
}

// The item the band keeps showing after it left the active statuses (blocked, or just merged), until the next turn starts.
export const bandHold = { item: '', sawIdle: false }

/**
 * The band's data while an item is planning, building or in review, and for a blocked or just-merged item until the
 * model's next turn starts (`isWorking` false once, then true again); nothing when idle.
 */
export async function bandNow(h: Host, isWorking: boolean): Promise<Band | null> {
  const b = await read(h, backlog)
  let item = await activeItem(h, b)
  if (item) {
    bandHold.item = item.id
    bandHold.sawIdle = false
  } else if (bandHold.item) {
    const held = b?.items.find(i => i.id === bandHold.item)
    if (held && (held.status === 'blocked' || held.status === 'merged')) {
      if (!isWorking) bandHold.sawIdle = true
      else if (bandHold.sawIdle) bandHold.item = ''
      if (bandHold.item) item = held
    } else bandHold.item = ''
  }
  if (!item) return null
  const found = (await read(h, root)) || (await resolveRoot(h))
  const ledger = await drawnLedger(h, found, item.id)
  const at = Math.max(await read(h, now), await h.clock.now())
  const agent = (await read(h, agents)).find(a => a.status === 'running')
  return bandOf(item, ledger, agent, at)
}
