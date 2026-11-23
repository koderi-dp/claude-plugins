import { atom as ccAtom, read as ccRead, update as ccUpdate } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Backlog, Config, Item, Ledger, Panel, QueueFilter, View } from '../../types'
import { DEFAULTS, normalizeConfig } from '../../core/config'
import { paths, serialize } from '../../core/files'
import { NEEDS_DESCRIPTION, bgEnd, isDescribed, isLive, notificationOf } from '../../core/background'
import { parseLive, withoutEntry } from '../../core/live'
import { mergedLine } from '../../core/merged'
import { BAND_COMPACT_H, BAND_H, bandSvg, bandText, idleStripSvg, idleStripText } from '../../core/draw'
import { BLOCKED, renderPanel } from './pane'
import { SEGMENT_COLORS, idLabel } from '../../core/status'
import type { Band } from '../../core/status'
import { isProtected, normalizeCommand, toolFileNote, toolFileOf, toolFileWrittenBy, onCall, onComplete, onResult, onSpawn, onStep, onTouch, pathOf } from '../../core/watch'
import type { Call } from '../../core/watch'
import { read, update } from '../../core/state'
import type { Atom } from '../../core/state'
import type { Host } from '../../core/host'
import {
  opts,
  BEGUN_PROMPT,
  CLEAN_PROMPT,
  CONFIG_FILE,
  type CommandAnswer,
  DESCRIPTION,
  DIRECT_PROMPT,
  DISCUSS_PROMPT,
  EDIT_TOOLS,
  ID,
  INIT_PROMPT,
  INTAKE_PROMPT,
  MIGRATE_GITHUB_PROMPT,
  MIGRATE_PROMPT,
  NEEDS_TOOL,
  NO_TOOL,
  PANE,
  QUEUE_PROMPT,
  RUN_PROMPT,
  SESSION_RUN_PROMPT,
  SHELL_TOOLS,
  STOP_PROMPT,
  TOOL,
  TOOL_DESCRIPTION,
  TOOL_SCHEMA,
  type ToolInput,
  USAGE,
  activeItem,
  agents,
  arrive,
  background,
  backlog,
  bandNow,
  beginInCode,
  begunText,
  branchOf,
  call,
  checkBackground,
  checkMerged,
  children,
  config,
  configCommand,
  drawnLedger,
  fileError,
  gather,
  heartbeat,
  idArg,
  idleText,
  isIssueQueue,
  isSessionRunner,
  limitsOf,
  list,
  liveFile,
  loadAll,
  loadLedger,
  memo,
  notWithIssues,
  noteBackground,
  now,
  panel,
  pressTool,
  protectedOf,
  readText,
  reconcileBackground,
  renameNow,
  resolveRoot,
  root,
  runTool,
  saveTranscript,
  scheduleWake,
  tick,
  WAKE_PROMPT,
  self,
  signals,
  siblings,
  slashes,
  specLine,
  stopBackground,
} from '../../core/engine'

// ---------- the host: Claude Code's `$` as the core's Host ----------

// The engine lists what a module reads and writes from its source, so each value is named here by a literal and each
// call on `$` is spelled out; the core names neither.
const s_root = ccAtom({ plugin: 'pipeline', key: 'root' } as const, root.initial)
const s_config = ccAtom({ plugin: 'pipeline', key: 'config' } as const, config.initial)
const s_backlog = ccAtom({ plugin: 'pipeline', key: 'backlog' } as const, backlog.initial)
const s_fileError = ccAtom({ plugin: 'pipeline', key: 'fileError' } as const, fileError.initial)
const s_agents = ccAtom({ plugin: 'pipeline', key: 'agents' } as const, agents.initial)
const s_signals = ccAtom({ plugin: 'pipeline', key: 'signals' } as const, signals.initial)
const s_background = ccAtom({ plugin: 'pipeline', key: 'background' } as const, background.initial)
const s_children = ccAtom({ plugin: 'pipeline', key: 'children' } as const, children.initial)
const s_siblings = ccAtom({ plugin: 'pipeline', key: 'siblings' } as const, siblings.initial)
const s_panel = ccAtom({ plugin: 'pipeline', key: 'panel' } as const, panel.initial)
const s_now = ccAtom({ plugin: 'pipeline', key: 'now' } as const, now.initial)

/**
 * The Host the core runs on in Claude Code: every member is the engine's own call of the same name. Built anew for
 * each use, since the engine lets `$` be passed to a function of this module and nowhere else.
 */
function hostOf($: EngineInterface): Host {
  return {
    fs: {
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      exists: path => $.fs.exists(path),
      list: path => $.fs.list(path),
    },
    clock: {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    process: {
      run: (argv, init) => $.process.run(argv, init),
      spawn: request => $.process.spawn(request),
      hookEnv: () => $.process.hookEnv(),
    },
    session: {
      id: () => $.session.id(),
      root: () => $.session.root(),
      cwd: () => $.session.cwd(),
      repo: () => $.session.repo(),
      info: () => $.session.info(),
    },
    env: {
      // `$.env.get` takes a literal name, so the module's reads can be listed.
      get: name => (name === 'HOME' ? $.env.get('HOME') : name === 'USERPROFILE' ? $.env.get('USERPROFILE') : $.env.get('PIPELINE_CHILD')),
    },
    settings: { read: () => $.settings.read({ key: 'permissions' }) },
    state: {
      read: async a => {
        switch (a.ref.key) {
        case 'root':
          return (await ccRead($, s_root)) as never
        case 'config':
          return (await ccRead($, s_config)) as never
        case 'backlog':
          return (await ccRead($, s_backlog)) as never
        case 'fileError':
          return (await ccRead($, s_fileError)) as never
        case 'agents':
          return (await ccRead($, s_agents)) as never
        case 'signals':
          return (await ccRead($, s_signals)) as never
        case 'background':
          return (await ccRead($, s_background)) as never
        case 'children':
          return (await ccRead($, s_children)) as never
        case 'siblings':
          return (await ccRead($, s_siblings)) as never
        case 'panel':
          return (await ccRead($, s_panel)) as never
        case 'now':
          return (await ccRead($, s_now)) as never
        }
        return a.initial
      },
      update: async (a, fn) => {
        switch (a.ref.key) {
        case 'root':
          return void (await ccUpdate($, s_root, fn as never))
        case 'config':
          return void (await ccUpdate($, s_config, fn as never))
        case 'backlog':
          return void (await ccUpdate($, s_backlog, fn as never))
        case 'fileError':
          return void (await ccUpdate($, s_fileError, fn as never))
        case 'agents':
          return void (await ccUpdate($, s_agents, fn as never))
        case 'signals':
          return void (await ccUpdate($, s_signals, fn as never))
        case 'background':
          return void (await ccUpdate($, s_background, fn as never))
        case 'children':
          return void (await ccUpdate($, s_children, fn as never))
        case 'siblings':
          return void (await ccUpdate($, s_siblings, fn as never))
        case 'panel':
          return void (await ccUpdate($, s_panel, fn as never))
        case 'now':
          return void (await ccUpdate($, s_now, fn as never))
        }
      },
    },
    ui: {
      toast: text => $.ui.toast(text),
      reveal: reason => autoOpen($, reason),
    },
    prompt: { submit: input => $.prompt.submit({ text: input.text }) },
    command: { run: input => $.command.run({ command: 'rename', args: input.args }) },
    tool: {
      list: () => $.tool.list(),
      call: input =>
        input.tool === 'PushNotification'
          ? $.tool.call({ tool: 'PushNotification', message: input.message, status: 'proactive' })
          : input.tool === 'ScheduleWakeup'
            ? $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: input.delaySeconds, reason: input.reason, prompt: input.prompt, noop: true })
            : $.tool.call({ tool: 'TaskStop', task_id: input.task_id } as never),
    },
  }
}

/** Opens the pane and answers why it is not drawn, or '' when it is. */
async function openPane($: EngineInterface, focus = false): Promise<string> {
  const at = await $.clock.now()
  await update(hostOf($), now, () => at)
  const r = await $.ui.open({ id: PANE, title: 'Pipeline', ...(focus ? { focus: true } : {}) })
  return r && r.isPlaced === false ? r.reason || 'no surface draws it' : ''
}

/** The band's Panel button: opens the pane, or brings it forward with the keys when it is open. */
async function showPane($: EngineInterface): Promise<void> {
  try {
    await openPane($, await isPaneOpen($))
  } catch {}
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    return false
  }
}

/** Whether the pane is open and a surface draws it: one opened unasked may wait undrawn. */
async function isPaneDrawn($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced !== false)
  } catch {
    return false
  }
}

/** The command's toggle: closes a pane that is drawn, opens any other. Answers what to say. */
async function togglePane($: EngineInterface): Promise<string> {
  if (await isPaneDrawn($)) {
    await $.ui.close({ id: PANE })
    // The band's Panel button reads the pane's state when drawn: the atom write redraws it.
    const at = await $.clock.now()
    await update(hostOf($), now, () => at)
    return 'Pipeline panel closed.'
  }
  // A pane that is open but undrawn (opened unasked) is opened again: the person's command is the ask that seats it.
  const why = await openPane($)
  return why ? `Pipeline panel is open but not drawn here: ${why}` : 'Pipeline panel opened.'
}

/** Opens the panel by itself, once per reason, unless the setting says never. */
async function autoOpen($: EngineInterface, reason: string): Promise<void> {
  if (!opts.isAutoOpen) return
  const p = await read(hostOf($), panel)
  if (p.autoOpenedFor.split(',').includes(reason)) return
  await update(hostOf($), panel, prev => ({ ...prev, autoOpenedFor: [prev.autoOpenedFor, reason].filter(Boolean).join(',') }))
  try {
    await openPane($)
  } catch {}
}

export const register: Register = (on, options) => {
  opts.isAutoOpen = (options as Record<string, unknown> | undefined)?.autoOpen !== 'never'
  opts.isCompactBand = (options as Record<string, unknown> | undefined)?.band === 'compact'
  opts.isIdleStrip = (options as Record<string, unknown> | undefined)?.idleStrip !== 'hide'
  opts.isCompactTasks = (options as Record<string, unknown> | undefined)?.tasks === 'compact'
  opts.isTranscripts = (options as Record<string, unknown> | undefined)?.transcripts === 'on'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Each step on its own, so a refused registration never keeps the files from loading.
    try {
      await $.command.register({ name: 'pipeline', description: DESCRIPTION, argumentHint: 'subcommand' })
    } catch {}
    // A host that takes the command but not the tool leaves the model with nothing to call: said once, never hidden.
    if (!(await registerTool($))) {
      try {
        await $.ui.toast(`pipeline: ${NO_TOOL()}`)
      } catch {}
    }
    let loaded: { found: string; config: Config | null; backlog: Backlog | null } | null = null
    try {
      const found = await resolveRoot(hostOf($))
      loaded = { found, ...(await loadAll(hostOf($), found)) }
    } catch {}
    try {
      self.sessionRoot = slashes(await $.session.root())
    } catch {}
    try {
      await arrive(hostOf($))
    } catch {}
    // A PR merged by hand since the last session: the person hears it once, in a toast; the status block says it too.
    try {
      if (loaded) for (const m of await checkMerged(hostOf($), loaded.found, loaded.config, loaded.backlog)) $.ui.toast(`pipeline: ${mergedLine({ ...m, id: idLabel(m.id) })}`)
    } catch {}
    return started
  })

  on('session.end', async ($, e, next) => {
    try {
      const path = await liveFile(hostOf($))
      const current = parseLive((await readText(hostOf($), path)) ?? '')
      // The ending session's id is the event's: after a /clear or a resume `$.session.id()` may already answer
      // the id the process goes on under, and the entry under the old one would stay in the file for a day.
      const ending = typeof e.sessionId === 'string' && e.sessionId ? e.sessionId : await $.session.id()
      await $.fs.write(path, serialize(withoutEntry(current, ending)))
    } catch {}
    await saveTranscript(hostOf($), typeof e.sessionId === 'string' && e.sessionId ? e.sessionId : undefined)
    return next(e)
  })

  // The session's permission mode, as the engine tells it on each prompt and each spawn: a child runs in it.
  on('classic.UserPromptSubmit', async (_$, e, next) => {
    try {
      const mode = (e as { permission_mode?: unknown }).permission_mode
      if (typeof mode === 'string' && mode) self.permissionMode = mode
    } catch {}
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    try {
      if (typeof e.permissionMode === 'string' && e.permissionMode) self.permissionMode = e.permissionMode
    } catch {}
    const started = await next(e)
    try {
      if (started && started.deny === undefined && typeof started.model === 'string') {
        const at = await $.clock.now()
        await update(hostOf($), agents, list => onSpawn(list, { id: started.agentId ?? e.tool_use_id, ...(started.agentId ? { agentId: started.agentId } : {}), name: e.description, model: started.model, at }))
        await heartbeat(hostOf($), true)
        await autoOpen($, 'agents')
      }
    } catch {}
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    if (agentId) {
      try {
        const at = await $.clock.now()
        await update(hostOf($), agents, list => onStep(list, agentId, result.usage, at))
      } catch {}
    } else {
      // The lead's own use: re-reading the conversation on every turn is most of an item's cost.
      const u = (result.usage ?? {}) as Record<string, number | undefined>
      self.lead.tokens += (u['input_tokens'] ?? 0) + (u['output_tokens'] ?? 0) + (u['cache_creation_input_tokens'] ?? 0)
      self.lead.cached += u['cache_read_input_tokens'] ?? 0
    }
    return result
  })

  // A subagent's call: a protected path is refused before it runs; otherwise its
  // activity line, and for a shell command whether it failed. The main session's passes.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const call = e as unknown as Call
    // The files only the tool writes: an edit or a shell write by anyone, the lead included, is refused and pointed
    // at the action that does it, so every write is checked, locked and followed by the generated view.
    try {
      if (await read(hostOf($), config)) {
        const file = EDIT_TOOLS.has(e.tool) ? toolFileOf(pathOf(call) ?? '') : e.tool === 'Bash' ? toolFileWrittenBy(String((call as Record<string, unknown>)['command'] ?? '')) : undefined
        if (file) return { deny: toolFileNote(file) }
      }
    } catch {}
    // A background command is listed in the panel by its description: one without is sent back for it, the lead's
    // and a subagent's alike, in a project with a pipeline.
    try {
      const input = call as unknown as Record<string, unknown>
      if (SHELL_TOOLS.has(e.tool) && input['run_in_background'] === true && !isDescribed(input['description'], input['command']) && (await read(hostOf($), config))) return { deny: NEEDS_DESCRIPTION }
    } catch {}
    if (!agentId) {
      const result = await next(e)
      await noteBackground(hostOf($), e.tool, call, result, undefined)
      return result
    }
    try {
      if (EDIT_TOOLS.has(e.tool)) {
        const path = pathOf(call)
        // The session's root is read now, not at session.start: the lead may have entered a worktree since.
        let sessionRoot = self.sessionRoot
        try {
          sessionRoot = slashes(await $.session.root())
          self.sessionRoot = sessionRoot
        } catch {}
        if (path && isProtected(path, protectedOf(await read(hostOf($), config)), [sessionRoot, await read(hostOf($), root)])) {
          return { deny: `pipeline: ${path} is protected by ${CONFIG_FILE} protectedPaths` }
        }
      }
      // A command that already failed three times in a row, unchanged, is not run a fourth time: the agent is told
      // so directly, which costs the lead no turn.
      if (e.tool === 'Bash') {
        const own = (await read(hostOf($), agents)).find(a => a.agentId === agentId || a.id === agentId)
        const cmd = normalizeCommand(String((call as Record<string, unknown>)['command'] ?? ''))
        if (own && cmd && own.lastCommands.length >= 3 && own.lastCommands.slice(-3).every(x => x === cmd)) {
          return { deny: `pipeline: this exact command failed three times in a row. Running it again will not change the result. Read the error, change the approach, or stop and answer BLOCKED with what you tried.` }
        }
      }
      const at = await $.clock.now()
      await update(hostOf($), agents, list => onCall(list, agentId, call, at))
      void heartbeat(hostOf($))
    } catch {}
    const result = await next(e)
    try {
      // The call came back: a sign of life, so one long shell command is not flagged silent.
      const at = await $.clock.now()
      await update(hostOf($), agents, list => onTouch(list, agentId, at))
      if (e.tool === 'Bash') {
        const isError = Boolean(result && typeof result === 'object' && 'isError' in result && result.isError)
        await update(hostOf($), agents, list => onResult(list, agentId, call, isError))
      }
    } catch {}
    await noteBackground(hostOf($), e.tool, call, result, agentId)
    return result
  })

  // A background task's notification is how the engine says it ended: it leaves the panel's list.
  on('prompt.submit', async ($, e, next) => {
    try {
      const told = (e as { origin?: { kind?: string } }).origin?.kind === 'task-notification' ? notificationOf(e.text) : null
      if (told && !isLive(told.status)) await update(hostOf($), background, list => bgEnd(list, told.id))
    } catch {}
    // The wake-up asks the model to read the signals. With none open that turn says "no signals" and costs a read of
    // the whole conversation, so the prompt is dropped here and the next wake-up is asked for in its place.
    try {
      if (e.text.trim() === WAKE_PROMPT) {
        await tick(hostOf($))
        if (!(await read(hostOf($), signals)).some(s => !s.delivered)) {
          self.wakeUntil = -Infinity
          await scheduleWake(hostOf($), await $.clock.now())
          return { drop: 'pipeline: no watchdog signal is open' }
        }
      }
    } catch {}
    return next(e)
  })

  // A turn's end and a subagent's end name what is still in flight: the list is set against it, so a command that
  // ended without a notification this session saw does not stay listed.
  on('classic.Stop', async ($, e, next) => {
    await reconcileBackground(hostOf($), (e as { background_tasks?: unknown }).background_tasks)
    return next(e)
  })
  on('classic.SubagentStop', async ($, e, next) => {
    await reconcileBackground(hostOf($), (e as { background_tasks?: unknown }).background_tasks)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    try {
      const at = await $.clock.now()
      const agentId = e.agentId
      if (agentId) await update(hostOf($), agents, list => onComplete(list, agentId, e.reason, at))
      await heartbeat(hostOf($), true)
      if (!agentId) await scheduleWake(hostOf($), at)
    } catch {}
    if (!e.agentId) await renameNow(hostOf($))
    // Not waited on: a large transcript must not hold the turn's end.
    if (!e.agentId) void saveTranscript(hostOf($))
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId) return { result: 'ignored: subagents do not write the pipeline' }
    try {
      const input = e as unknown as ToolInput
      const result = await runTool(hostOf($), input)
      // The lead's own work on an item makes it this session's: the panel, the band and `get` follow it.
      const worked = ['ledger', 'plan', 'brief', 'begin', 'accept', 'gate', 'pr', 'ship'].includes(input.action) ? (typeof input.item === 'string' ? input.item : input.item?.id ?? input.id) : input.action === 'update' && ['planning', 'building'].includes(String((input.set as Partial<Item> | undefined)?.status)) ? input.id : undefined
      if (worked && !(await read(hostOf($), children)).some(ch => ch.item === worked)) self.item = worked
      // A block the lead sets goes into the item's record too, so one call does both. Only for the lead's own
      // call: a migration that carries a blocked item over writes its record itself.
      const set = input.action === 'update' ? (input.set as Record<string, unknown> | undefined) : undefined
      if (input.id && set?.['status'] === 'blocked' && typeof set['note'] === 'string' && set['note'].trim() && !String(result).startsWith('refused')) {
        try {
          const root = await resolveRoot(hostOf($))
          if (await loadLedger(hostOf($), root, input.id)) await runTool(hostOf($), { action: 'ledger', item: input.id, set: { blockers: [set['note'].trim()] } })
        } catch {}
      }
      return { result }
    } catch (err) {
      return { result: `refused: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('command.run', { command: 'pipeline' }, async ($, e) => {
    try {
      return await runCommand($, e.args)
    } catch (err) {
      return { text: `pipeline: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    try {
      return await drawPane($, ui, e)
    } catch (err) {
      const { Text } = ui as unknown as { Text: (p: Record<string, unknown>) => RenderElement }
      return <Text color={BLOCKED}>{`pipeline: ${err instanceof Error ? err.message : String(err)}`}</Text>
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let band: Band | null = null
    try {
      if (!e.props.hasSurvey) band = await bandNow(hostOf($), e.props.isWorking)
    } catch {}
    const strip = band ? '' : await idleText(hostOf($), e.props.hasSurvey)
    if (!band && !strip) return next(e)
    // The engine's own placeholder ({ type: 'engine' }) is never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const other = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const cols = e.props.bodyColumns || 100
    if (!band) {
      // Nothing active: one slim line with the Open panel button, so the panel is a press away.
      const button = <Button key="band-panel" plain dimColor hotkey="p" label="Open panel" onPress={() => void showPane($)} />
      if (e.surface !== 'terminal' && 'Svg' in ui) {
        const { Svg } = ui
        const width = Math.max(180, Math.min(1600, cols * 8 - 40)) - 24
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" alignItems="flex-start">
              <Svg source={idleStripSvg(strip, width)} alt={strip} width={width} height={BAND_COMPACT_H} />
              {button}
            </Box>
            {other}
          </Box>
        )
      }
      // The row, the gap and the button's `[ Open panel ]` share the columns.
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{idleStripText(strip, Math.max(10, cols - 4 - 'Open panel'.length - 5))}</Text>
            {button}
          </Box>
          {other}
        </Box>
      )
    }
    const panelButton = <Button key="band-panel" plain dimColor hotkey="p" label={(await isPaneOpen($)) ? 'Panel ↗' : 'Panel'} onPress={() => void showPane($)} />
    let isOpen = false
    try {
      isOpen = (await read(hostOf($), panel)).isBandOpen
    } catch {}
    const toggle = () => void update(hostOf($), panel, prev => ({ ...prev, isBandOpen: !prev.isBandOpen }))
    const chevron = <Button key="band-expand" plain dimColor label={isOpen ? '⌃' : '⌄'} onPress={toggle} />
    const details = isOpen ? (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>{`Execution tasks · ${band.summary}`}</Text>
        {band.tasks.map((t, i) => (
          <Text key={`band-task-${i}`} color={t.segment === 'accepted' ? SEGMENT_COLORS.accepted : t.segment === 'current' ? band!.color : t.segment === 'blocked' ? SEGMENT_COLORS.blocked : undefined} dimColor={t.segment === 'pending'}>
            {`${t.segment === 'accepted' ? '✓' : t.segment === 'current' ? '•' : t.segment === 'blocked' ? '✕' : '○'} ${t.title}`}
          </Text>
        ))}
        {!band.tasks.length ? <Text dimColor>No ledger yet.</Text> : null}
      </Box>
    ) : null
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const width = Math.max(180, Math.min(1600, cols * 8 - 40)) - 24
      const height = opts.isCompactBand ? BAND_COMPACT_H : BAND_H
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="flex-start">
            <Svg source={bandSvg(band, width, opts.isCompactBand)} alt={`${band.id} ${band.state}: ${band.title}, ${band.count}, ${band.activity}`} width={width} height={height} />
            {chevron}
            {panelButton}
          </Box>
          {details}
          {other}
        </Box>
      )
    }
    const row = bandText(band, Math.max(10, cols - 4))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={band.color} bold>
            {row.head}
          </Text>
          {row.segments ? (
            <Text>
              <Text dimColor>· </Text>
              {band.segments.map((seg, i) => (
                <Text key={`seg-${i}`} color={seg === 'pending' ? undefined : seg === 'current' ? band!.color : SEGMENT_COLORS[seg]} dimColor={seg === 'pending'}>
                  {row.segments.charAt(i)}
                </Text>
              ))}
              {!band.segments.length ? <Text dimColor>▱</Text> : null}
            </Text>
          ) : null}
          {row.tail ? <Text dimColor>{`· ${row.tail}`}</Text> : null}
          {chevron}
          {panelButton}
        </Box>
        {details}
        {other}
      </Box>
    )
  })

}

// ---------- the commands ----------

/** Gives the model the tool; false, with the reason kept, when this host refuses it. */
async function registerTool($: EngineInterface): Promise<boolean> {
  try {
    // In a project without a pipeline the tool is listed by name only, so it costs no context there.
    let hasPipeline = false
    try {
      hasPipeline = await $.fs.exists(paths(await resolveRoot(hostOf($))).config)
    } catch {}
    await $.tool.register({ name: 'pipeline', description: TOOL_DESCRIPTION, isDeferred: !hasPipeline, inputSchema: TOOL_SCHEMA })
    self.toolError = ''
    return true
  } catch (err) {
    self.toolError = (err instanceof Error ? err.message : String(err)) || 'no reason given'
    return false
  }
}

/** `/pipeline <sub> ...`: text for what the mod answers itself, a prompt for what the model does. */
async function runCommand($: EngineInterface, args: string): Promise<CommandAnswer> {
  const [sub = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  // An id argument may be written as #12: the subcommands that take an id read it without the #.
  const arg = ['status', 'run', 'stop', 'log', 'park', 'unpark'].includes(sub) ? idArg(rest.join(' ')) : rest.join(' ')
  // The engine refuses a submit from inside the command's own hook (it would wait on
  // the turn the hook holds), so the submit goes out from a timer once this hook is done.
  const prompt = (text: string, instruction: string): CommandAnswer => {
    $.clock.after(50, async () => {
      // An item begun by the command is named now, while no turn runs: at the turn's end would be after the whole build.
      // Never waited on for long: a surface that holds the rename back must not hold the prompt back.
      try {
        await Promise.race([renameNow(hostOf($)), new Promise<void>(done => $.clock.after(1500, () => done()))])
      } catch {}
      try {
        await $.prompt.submit({ text: instruction })
      } catch (err) {
        $.ui.toast(`pipeline: could not start the step: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
    return { text }
  }
  // Without the tool the model would be sent into a dead end: one more try, then said plainly before anything is claimed.
  if (self.toolError && NEEDS_TOOL.includes(sub) && !(await registerTool($))) return { text: `pipeline: ${NO_TOOL()}` }
  switch (sub) {
    case 'status':
      return { text: `${await runTool(hostOf($), { action: 'status', ...(arg ? { id: arg } : {}) })}${self.toolError ? `\n\n${NO_TOOL()}` : ''}` }
    case 'panel': {
      return { text: await togglePane($) }
    }
    case 'config':
      return { text: await configCommand(hostOf($), arg) }
    case 'init':
      return prompt('pipeline: setting up…', INIT_PROMPT)
    case 'migrate':
      // `migrate github`: a project already on a file backlog moves onto issues; the plain form is for a project with no pipeline yet.
      if (/^(github|issues)$/i.test(arg.trim())) return prompt('pipeline: moving the backlog onto GitHub issues…', MIGRATE_GITHUB_PROMPT)
      return prompt('pipeline: migrating…', MIGRATE_PROMPT)
    case 'add':
      if (!arg) return { text: 'pipeline: add needs the request, as /pipeline add <text>' }
      return prompt(`pipeline: intake of "${arg}"…`, INTAKE_PROMPT(arg))
    case 'adopt':
      if (!/^#?\d+$/.test(arg)) return { text: 'pipeline: adopt needs a pull request number, as /pipeline adopt 114' }
      return { text: await runTool(hostOf($), { action: 'adopt', pr: `#${arg.replace('#', '')}` }) }
    case 'discuss':
      if (!arg) return { text: 'pipeline: discuss needs a request or an item, as /pipeline discuss <text or id>' }
      return prompt(`pipeline: discussing "${arg}"…`, DISCUSS_PROMPT(arg))
    case 'next': {
      const begun = await beginInCode(hostOf($), '')
      if (begun) return 'refused' in begun ? { text: `pipeline: ${begun.refused}` } : prompt(begunText(begun), (begun.isDirect ? DIRECT_PROMPT : BEGUN_PROMPT)(begun.answer, begun.id, false))
      return prompt('pipeline: running the first ready item…', (await isSessionRunner(hostOf($))) ? SESSION_RUN_PROMPT('') : RUN_PROMPT(''))
    }
    case 'run': {
      if (!arg || (arg !== 'all' && !ID.test(arg))) return { text: 'pipeline: run needs an id or all, as /pipeline run p12' }
      const begun = await beginInCode(hostOf($), arg === 'all' ? '' : arg)
      if (begun) return 'refused' in begun ? { text: `pipeline: ${begun.refused}` } : prompt(begunText(begun), (begun.isDirect ? DIRECT_PROMPT : BEGUN_PROMPT)(begun.answer, begun.id, arg === 'all'))
      return prompt(arg === 'all' ? 'pipeline: running until nothing is ready…' : `pipeline: running ${arg}…`, (await isSessionRunner(hostOf($))) ? SESSION_RUN_PROMPT(arg) : RUN_PROMPT(arg))
    }
    case 'stop':
      if (arg && ID.test(arg)) return { text: await runTool(hostOf($), { action: 'stop', item: arg }) }
      return prompt('pipeline: stopping after the running task…', STOP_PROMPT)
    case 'log':
      if (!ID.test(arg)) return { text: 'pipeline: log needs an id, as /pipeline log p12' }
      return { text: await runTool(hostOf($), { action: 'log', item: arg }) }
    case 'clean':
      return prompt('pipeline: cleaning…', CLEAN_PROMPT)
    case 'move': {
      if (await isIssueQueue(hostOf($))) return { text: `refused: ${notWithIssues('move')}` }
      const [id = '', where = '', after = ''] = rest.map(idArg)
      const to = where === 'top' ? 'top' : where === 'after' && ID.test(after) ? { after } : null
      if (!ID.test(id) || !to) return { text: 'pipeline: move needs an id and a place, as /pipeline move p12 top or /pipeline move p12 after p9' }
      return prompt(`pipeline: moving ${id}…`, QUEUE_PROMPT({ action: 'move', id, to }))
    }
    case 'park':
    case 'unpark':
      if (!ID.test(arg)) return { text: `pipeline: ${sub} needs an id, as /pipeline ${sub} p12` }
      return prompt(`pipeline: ${sub === 'park' ? 'parking' : 'unparking'} ${arg}…`, QUEUE_PROMPT({ action: sub, id: arg }))
    default:
      return { text: USAGE }
  }
}

async function drawPane($: EngineInterface, ui: ReturnType<EngineInterface['ui']['resolve']>, e: { surface: string; props: { bodyColumns?: number } }): Promise<RenderElement> {
  const found = (await read(hostOf($), root)) || (await resolveRoot(hostOf($)))
  const c = await read(hostOf($), config)
  const b = await read(hostOf($), backlog)
  const d = await gather(hostOf($), found, c, b, await read(hostOf($), fileError), true)
  const p = await read(hostOf($), panel)
  const kids = await read(hostOf($), children)
  const ledgers: Record<string, Ledger | null> = {}
  for (const k of kids) ledgers[k.item] = await drawnLedger(hostOf($), found, k.item)
  const set = (patch: Partial<Panel>) => void update(hostOf($), panel, prev => ({ ...prev, ...patch }))
  return renderPanel(ui, {
    ...d,
    now: Math.max(d.now, await read(hostOf($), now)),
    surface: e.surface,
    hasSvg: 'Svg' in ui,
    bodyColumns: e.props.bodyColumns ?? 40,
    project: found.split('/').pop() || 'project',
    branch: (await branchOf(hostOf($))) ?? '',
    panel: p,
    children: kids,
    siblings: await read(hostOf($), siblings),
    background: await read(hostOf($), background),
    ledgers,
    activeLine: await memo(hostOf($), `what:${d.activeId ?? ''}`, b, 10_000, async () => specLine(hostOf($), found, await activeItem(hostOf($), b))),
    limitMs: limitsOf(c).taskMinutes * 60_000,
    fixRounds: limitsOf(c).fixRounds,
    taskReview: c ? normalizeConfig(c).config.taskReview : DEFAULTS.taskReview,
    tasksMode: opts.isCompactTasks ? 'compact' : 'expanded',
    onView: (view: View) => set({ view }),
    onActivity: () => void update(hostOf($), panel, prev => ({ ...prev, isActivityOpen: !prev.isActivityOpen })),
    onFilter: (filter: QueueFilter) => set({ filter, expanded: null }),
    onSearch: (search: string) => set({ search, expanded: null }),
    onExpand: (expanded: string | null) => set({ expanded }),
    onMore: () => void update(hostOf($), panel, prev => ({ ...prev, isMoreShown: !prev.isMoreShown })),
    onStop: (item: string) => void pressTool(hostOf($), { action: 'stop', item }),
    onLog: (item: string) => void pressTool(hostOf($), { action: 'log', item }),
    onBgStop: (id: string) => void stopBackground(hostOf($), id),
    onBgCheck: (id: string) => void checkBackground(hostOf($), id),
  })
}
