/**
 * The pipeline in opencode (version 2): the `pipeline` tool and the pipeline skills, on the Node host.
 *
 * Loaded by opencode as a plugin folder: add this folder's path to `plugins` in opencode.jsonc. What opencode has
 * no place for is left out and said in the README: the panel, the watchdog over subagents, the background commands.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TOOL_DESCRIPTION, TOOL_SCHEMA, runTool } from '../../core/engine'
import type { ToolInput } from '../../core/engine'
import { inSession, nodeHost } from '../node/host'
import { hostNote, skillsIn } from '../node/skills'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '../..')

const NOTE = hostNote({
  program: 'opencode',
  tool: 'the `pipeline` tool',
  agent: 'call `subagent` with `agent: "general"` and the prompt the tool answered (give a reviewer the instruction not to edit files)',
  shell: '`shell`',
})

// What opencode hands a plugin, as far as this file uses it.
type Ctx = {
  location?: { directory?: string }
  tool?: { transform: (fn: (editor: { add: (tool: unknown) => void }) => void) => Promise<unknown> }
  skill?: { transform: (fn: (draft: { add: (skill: unknown) => void }) => void) => Promise<unknown> }
  session?: {
    get?: (input: { sessionID: string }) => Promise<{ id?: string; parentID?: string; directory?: string; location?: { directory?: string } } | undefined>
    update?: (input: { sessionID: string; title: string }) => Promise<unknown>
    prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>
  }
}

async function setup(ctx: Ctx): Promise<void> {
  // An opencode of version 1 calls setup too, with nothing this file can use.
  if (!ctx?.tool || typeof ctx.tool.transform !== 'function') return

  const sessionOf = async (sessionID: string) => {
    try {
      return (await ctx.session?.get?.({ sessionID })) ?? undefined
    } catch {
      return undefined
    }
  }

  try {
    await ctx.tool.transform(editor => {
      editor.add({
        name: 'pipeline',
        description: TOOL_DESCRIPTION,
        input: TOOL_SCHEMA,
        execute: async (input: ToolInput, context: { sessionID?: string }) => {
          const id = context?.sessionID ?? 'opencode'
          const session = await sessionOf(id)
          // As in Claude Code: the lead writes the pipeline, a subagent's session does not.
          if (session?.parentID) return { content: 'ignored: subagents do not write the pipeline' }
          const cwd = session?.directory ?? session?.location?.directory ?? ctx.location?.directory ?? process.cwd()
          try {
            const text = await inSession(id, () =>
              runTool(
                nodeHost({
                  id,
                  cwd,
                  pluginRoot,
                  dataDir: path.join(os.homedir(), '.local', 'share', 'pipeline'),
                  rename: title => ctx.session?.update?.({ sessionID: id, title }),
                  submit: text => ctx.session?.prompt?.({ sessionID: id, text }),
                }),
                input,
              ),
            )
            return { content: text }
          } catch (err) {
            return { content: `refused: ${err instanceof Error ? err.message : String(err)}` }
          }
        },
      })
    })
  } catch (err) {
    console.error('[pipeline] the tool was not registered:', err)
  }

  // The skills of this plugin, each with the note that says what its Claude Code words mean here.
  if (ctx.skill && typeof ctx.skill.transform === 'function') {
    try {
      const skills = skillsIn(path.join(pluginRoot, 'skills'), { existsSync, readFileSync, readdirSync })
      await ctx.skill.transform(draft => {
        for (const s of skills) {
          try {
            draft.add({ id: s.id, name: s.name, ...(s.description ? { description: s.description } : {}), path: s.path, content: `${s.content}\n\n${NOTE}\n` })
          } catch (err) {
            console.error(`[pipeline] skill ${s.id} was refused:`, err)
          }
        }
      })
    } catch (err) {
      console.error('[pipeline] the skills were not registered:', err)
    }
  }
}

export default { id: 'pipeline', setup }
