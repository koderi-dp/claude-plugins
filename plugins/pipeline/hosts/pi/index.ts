/**
 * The pipeline in pi: the `pipeline` tool, the `/pipeline` command, the skills, one status line in the footer, and
 * the refusal of edits to the files only the tool writes. On the Node host.
 *
 * pi has no subagents, so an item is built by the session itself: set `mode` to `direct` in the project's config.
 * pi has no panel and no background commands; those parts of the Claude Code host are left out.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

import {
  BEGUN_PROMPT,
  DIRECT_PROMPT,
  DISCUSS_PROMPT,
  ID,
  INIT_PROMPT,
  INTAKE_PROMPT,
  RUN_PROMPT,
  TOOL_DESCRIPTION,
  TOOL_SCHEMA,
  bandNow,
  beginInCode,
  begunText,
  configCommand,
  idArg,
  idleText,
  loadAll,
  resolveRoot,
  runTool,
} from '../../core/engine'
import type { ToolInput } from '../../core/engine'
import { bandText } from '../../core/draw'
import { toolFileNote, toolFileOf, toolFileWrittenBy } from '../../core/watch'
import { endSession, inSession, nodeHost } from '../node/host'
import { hostNote } from '../node/skills'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '../..')

const NOTE = hostNote({
  program: 'pi',
  tool: 'the `pipeline` tool',
  agent: 'pi has no subagents, so do that work yourself in this session, from the same brief (the project should run with `mode: "direct"`)',
  shell: '`bash`',
})

const USAGE = 'pipeline: status [id] | config [key=value] | init | add <text> | discuss <text or id> | next | run <id> | run all'

// What pi hands an extension, as far as this file uses it.
type Ui = { notify: (text: string, level: 'info' | 'warning' | 'error') => void; setStatus: (key: string, text: string | undefined) => void }
type Ctx = { cwd: string; hasUI?: boolean; ui: Ui; sessionManager: { getSessionId: () => string; getSessionFile: () => string | undefined } }
type Pi = {
  on: (event: string, handler: (event: never, ctx: Ctx) => unknown) => void
  registerTool: (tool: unknown) => void
  registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }) => void
  sendUserMessage: (text: string, options?: { deliverAs?: 'steer' | 'followUp' }) => void
  setSessionName: (name: string) => void
}

export default function pipeline(pi: Pi): void {
  const idOf = (ctx: Ctx) => {
    try {
      return ctx.sessionManager.getSessionId() || 'pi'
    } catch {
      return 'pi'
    }
  }
  const hostOf = (ctx: Ctx) =>
    nodeHost({
      id: idOf(ctx),
      cwd: ctx.cwd,
      pluginRoot,
      dataDir: path.join(os.homedir(), '.pi', 'agent', 'pipeline'),
      transcriptPath: () => ctx.sessionManager.getSessionFile(),
      notify: text => ctx.ui.notify(text, 'info'),
      rename: name => pi.setSessionName(name),
      // While a turn runs the prompt waits for its end.
      submit: text => pi.sendUserMessage(text, { deliverAs: 'followUp' }),
    })
  const as = <T,>(ctx: Ctx, fn: () => Promise<T>) => inSession(idOf(ctx), fn)

  /** The footer line: the item being built with its count, or the idle summary; nothing in a project without a pipeline. */
  const drawStatus = async (ctx: Ctx, isWorking: boolean) => {
    if (ctx.hasUI === false) return
    try {
      const line = await as(ctx, async () => {
        const h = hostOf(ctx)
        await loadAll(h, await resolveRoot(h))
        const band = await bandNow(h, isWorking)
        if (!band) return idleText(h, false)
        const t = bandText(band, 80)
        return [t.head, t.segments, t.tail].filter(Boolean).join(' · ')
      })
      ctx.ui.setStatus('pipeline', line || undefined)
    } catch {}
  }

  pi.on('resources_discover', async () => ({ skillPaths: [path.join(pluginRoot, 'skills')] }))

  // The skills are Claude Code's; the note says what their words mean here.
  pi.on('before_agent_start', async (event: never) => ({ systemPrompt: `${(event as { systemPrompt?: string }).systemPrompt ?? ''}\n\n${NOTE}` }))

  pi.on('session_start', async (_event, ctx) => drawStatus(ctx, false))
  pi.on('turn_end', async (_event, ctx) => void (await drawStatus(ctx, true)))
  pi.on('session_shutdown', async (_event, ctx) => endSession(idOf(ctx)))

  // The backlog, the ledgers and the facts are written by the tool alone, as in Claude Code.
  pi.on('tool_call', async (event: never) => {
    const e = event as { toolName?: string; input?: { path?: string; command?: string } }
    const file = e.toolName === 'write' || e.toolName === 'edit' ? toolFileOf(e.input?.path ?? '') : e.toolName === 'bash' ? toolFileWrittenBy(e.input?.command ?? '') : undefined
    if (file) return { block: true, reason: toolFileNote(file) }
    return undefined
  })

  pi.registerTool({
    name: 'pipeline',
    label: 'Pipeline',
    description: TOOL_DESCRIPTION,
    parameters: TOOL_SCHEMA,
    async execute(_toolCallId: string, params: ToolInput, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
      let text: string
      try {
        text = await as(ctx, () => runTool(hostOf(ctx), params))
      } catch (err) {
        text = `refused: ${err instanceof Error ? err.message : String(err)}`
      }
      await drawStatus(ctx, true)
      return { content: [{ type: 'text', text }], details: {} }
    },
  })

  pi.registerCommand('pipeline', {
    description: 'The pipeline: status, config, init, add, discuss, next, run',
    handler: async (args, ctx) => {
      const [sub = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
      const arg = ['status', 'run'].includes(sub) ? idArg(rest.join(' ')) : rest.join(' ')
      const say = (text: string) => ctx.ui.notify(text, 'info')
      const prompt = (text: string, instruction: string) => {
        say(text)
        pi.sendUserMessage(`${instruction}\n\n${NOTE}`)
      }
      try {
        await as(ctx, async () => {
          const h = hostOf(ctx)
          switch (sub) {
            case 'status':
              return say(await runTool(h, { action: 'status', ...(arg ? { id: arg } : {}) }))
            case 'config':
              return say(await configCommand(h, arg))
            case 'init':
              return prompt('pipeline: setting up…', INIT_PROMPT)
            case 'add':
              return arg ? prompt(`pipeline: intake of "${arg}"…`, INTAKE_PROMPT(arg)) : say('pipeline: add needs the request, as /pipeline add <text>')
            case 'discuss':
              return arg ? prompt(`pipeline: discussing "${arg}"…`, DISCUSS_PROMPT(arg)) : say('pipeline: discuss needs a request or an item, as /pipeline discuss <text or id>')
            case 'next':
            case 'run': {
              const isAll = sub === 'run' && arg === 'all'
              if (sub === 'run' && (!arg || (!isAll && !ID.test(arg)))) return say('pipeline: run needs an id or all, as /pipeline run p12')
              const target = sub === 'next' || isAll ? '' : arg
              const begun = await beginInCode(h, target)
              if (begun && 'refused' in begun) return say(`pipeline: ${begun.refused}`)
              if (begun) return prompt(begunText(begun), (begun.isDirect ? DIRECT_PROMPT : BEGUN_PROMPT)(begun.answer, begun.id, isAll))
              return prompt(target ? `pipeline: running ${target}…` : 'pipeline: running the first ready item…', RUN_PROMPT(isAll ? 'all' : target))
            }
            default:
              return say(USAGE)
          }
        })
      } catch (err) {
        ctx.ui.notify(`pipeline: ${err instanceof Error ? err.message : String(err)}`, 'error')
      }
      await drawStatus(ctx, false)
    },
  })
}
