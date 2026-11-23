// What the slash command answers in code, before or without the model.
import { read, update } from './state'
import type { Host } from './host'
import type { Item } from '../types'
import { DEFAULTS, normalizeConfig } from './config'
import { parseJson, paths, serialize } from './files'
import { specWhat } from './status'
import { worktreePath } from './actions'
import { isGithub, placesOf } from './github'
import { CONFIG_FILE, CONFIG_KEYS, config, fileError, loadAll, loadConfig, resolveRoot, root, self } from './shared'
import { loadLedger, runTool } from './tool'
import { activeItem, readText } from './watchdog'

export const NO_TOOL = () => `the pipeline tool could not be registered in this session (${self.toolError}), so the model cannot call it here: commands that only show or set things still work, building does not. Start the session in a terminal or the desktop app on the machine itself.`
/** The subcommands that hand the work to the model, which needs the tool. */
export const NEEDS_TOOL = ['add', 'discuss', 'next', 'run', 'init', 'migrate']

export type CommandAnswer = { text?: string; context?: readonly string[] }

/** What the command says at once when it began an item: the id and its title, before the model's first word. */
export const begunText = (b: { id: string; title: string }) => `pipeline: ${b.id}${b.title ? ` · ${b.title}` : ''} begun…`

export const ID = /^(?:[a-z][a-z0-9-]*|#?\d+)$/i
/** An id as the tool takes it: `#12` is issue 12. */
export const idArg = (id: string) => id.replace(/^#(?=\d+$)/, '')

/** Whether the config on disk says `queue: github`. */
export async function isIssueQueue(h: Host): Promise<boolean> {
  try {
    const found = (await read(h, root)) || (await resolveRoot(h))
    return isGithub((await loadConfig(h, found)).value)
  } catch {
    return false
  }
}

/** Whether the config on disk says `runner: session`, so the commands hand the model the start prompt. */
/**
 * With the in-session runner the command claims the item itself, before the model runs: the user sees which item
 * was picked and the session carries its name at once, and under mode direct the model starts with the spec in hand.
 * Answers null when the skill should drive from its own `get` (the session runner, an item whose ledger already
 * has tasks), and the refusal when nothing can be begun.
 */
export async function beginInCode(h: Host, target: string): Promise<{ id: string; title: string; answer: string; isDirect: boolean } | { refused: string } | null> {
  try {
    const found = (await read(h, root)) || (await resolveRoot(h))
    const { config: c, backlog: b } = await loadAll(h, found)
    const cfg = normalizeConfig(c ?? DEFAULTS).config
    if (!c || cfg.runner === 'session') return null
    // An item this session already runs is resumed, not passed over for the next ready one.
    const id = target || (await activeItem(h, b))?.id || ''
    if (id && ((await loadLedger(h, found, id))?.tasks.length ?? 0) > 0) return null
    const answer = await runTool(h, { action: 'begin', ...(id ? { item: id } : {}) })
    const begun = answer.split(' · ')[0] ?? id
    const title = (await loadAll(h, found)).backlog?.items.find(i => i.id === begun)?.title ?? ''
    return { id: begun, title, answer, isDirect: cfg.mode === 'direct' }
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err)
    // Nothing to begin, or the item is someone else's: said at once. Anything else (an item that still needs its
    // spec written, an id the backlog does not know) is the skill's to sort out.
    return /nothing is ready|another session|being built by|child session/.test(said) ? { refused: said } : null
  }
}

export async function isSessionRunner(h: Host): Promise<boolean> {
  try {
    const found = (await read(h, root)) || (await resolveRoot(h))
    return (await loadConfig(h, found)).value?.runner === 'session'
  } catch {
    return false
  }
}

/** `true`, `false` and numbers as themselves, a JSON array or object as parsed, anything else as text. */
export function parseValue(raw: string): unknown {
  const v = raw.trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  if (/^[[{]/.test(v)) {
    try {
      return JSON.parse(v)
    } catch {}
  }
  return v
}

/** Sets a dotted key in a copy of the object, making the objects on the way. */
export function setPath(obj: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const [head, ...tail] = key.split('.')
  if (!head) return obj
  if (!tail.length) return { ...obj, [head]: value }
  const inner = obj[head]
  return { ...obj, [head]: setPath(inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {}, tail.join('.'), value) }
}

/** `/pipeline config`: the config file as text; `key=value` sets one key once `normalizeConfig` accepts the result. */
export async function configCommand(h: Host, arg: string): Promise<string> {
  const found = await resolveRoot(h)
  const p = paths(found)
  const text = await readText(h, p.config)
  if (text === null) return 'pipeline: no config (run /pipeline init)'
  const parsed = parseJson<Record<string, unknown>>(text, CONFIG_FILE)
  if (!parsed.ok) return `pipeline: ${parsed.error}`
  if (!arg) return text.replace(/\n$/, '')
  const m = /^([A-Za-z][\w.]*)=([\s\S]*)$/.exec(arg)
  if (!m) return 'pipeline: config takes key=value, as /pipeline config merge=pr or limits.fixRounds=4'
  const key = m[1]!
  const raw = m[2]!
  const top = key.split('.')[0]!
  if (!CONFIG_KEYS.includes(top)) return `refused: no config key ${top}; the keys are ${CONFIG_KEYS.join(', ')}`
  const value = parseValue(raw)
  const current = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value : {}
  const next = setPath(current, key, value)
  const { problems } = normalizeConfig(next)
  if (problems.length) return `refused: ${problems.join('; ')}`
  await h.fs.write(p.config, serialize(next))
  await loadConfig(h, found)
  await update(h, fileError, () => null)
  return `${key} = ${JSON.stringify(value)}`
}

/** The first line of the active item's spec, for the running hero; nothing without a spec file. With queue: github, the spec cache in the item's worktree. */
export async function specLine(h: Host, found: string, item: Item | null): Promise<string> {
  if (!item) return ''
  const c = await read(h, config)
  if (isGithub(c)) {
    const ledger = await loadLedger(h, found, item.id)
    const text = ledger?.worktree ? await readText(h, `${worktreePath(found, ledger)}/${placesOf(found, c).specRel(item.id)}`) : null
    return text ? specWhat(text) : ''
  }
  if (typeof item.spec !== 'string' || !item.spec) return ''
  const text = await readText(h, `${found}/${item.spec.replace(/^\/+/, '')}`)
  return text ? specWhat(text) : ''
}
