/**
 * Saved session transcripts (the `transcripts` setting): where a session's folder is, what its record says, and
 * the transcript as a page a person can read. Pure: register.tsx reads and writes the files.
 */

/** A folder or file name from free text: letters, digits, dot, dash and underscore; anything else is a dash. */
export const safeName = (s: string): string =>
  s
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unnamed'

const pad = (n: number) => String(n).padStart(2, '0')

/** `2026-11-22_0931`, in the machine's own time zone. */
export function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
}

/**
 * The session's own folder under the plugin's data folder: `transcripts/<project>/<date>_<time>_<id>`. The name is
 * fixed when the session starts, so it never moves; what the session is called is in its `info.json` and the index.
 */
export const sessionFolder = (dataDir: string, project: string, sessionId: string, startedAt: number): string =>
  `${dataDir.replace(/\\/g, '/').replace(/\/+$/, '')}/transcripts/${safeName(project)}/${stamp(startedAt)}_${safeName(sessionId).slice(0, 8)}`

export type SessionRecord = {
  folder: string
  project: string
  cwd: string
  sessionId: string
  /** What the session is called: the name the pipeline gave it (`#59 · Article badges`), when it gave one. */
  name: string
  /** The pipeline items this session worked on. */
  items: string[]
  pluginVersion: string
  startedAt: string
  updatedAt: string
  /** The files the copy was made from. */
  source: string
  subagents: number
}

/** The project's index: one line per saved session, the newest first. */
export function indexMd(project: string, records: readonly SessionRecord[]): string {
  const rows = [...records].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-'
  return [
    `# Saved sessions · ${project}`,
    '',
    '| Folder | Session | Items | Subagents | Last turn |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(r => `| [${r.folder}](${r.folder}/session.md) | ${cell(r.name)} | ${cell(r.items.join(', '))} | ${r.subagents} | ${cell(r.updatedAt)} |`),
    '',
  ].join('\n')
}

const CLIP = 1500
const clip = (text: string, cap = CLIP): string => (text.length <= cap ? text : `${text.slice(0, cap)}\n… (${text.length - cap} more characters, in the .jsonl)`)

/** A tool result's content as text: a string as it is, a list of blocks as their text, images named. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content)
  return content.map(p => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : `[${String((p as { type?: unknown } | null)?.type ?? 'block')}]`)).join('\n')
}

const fence = (text: string): string => `\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\``

/**
 * A transcript file (.jsonl, one event per line) as a readable page: each prompt, each thing the model said, each
 * tool call with its input and its result, in order. Long inputs and results are clipped; the .jsonl beside it has
 * everything. A line that is not JSON is skipped.
 */
export function digest(jsonl: string, title: string): string {
  const out: string[] = [`# ${title}`, '']
  let calls = 0
  let errors = 0
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue
    let m: Record<string, unknown>
    try {
      m = JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue
    }
    const content = (m['message'] as { content?: unknown } | undefined)?.content
    const at = typeof m['timestamp'] === 'string' ? ` · ${m['timestamp']}` : ''
    if (m['type'] === 'user') {
      if (typeof content === 'string') {
        if (content.trim()) out.push(`## Prompt${at}`, '', clip(content, 4000), '')
        continue
      }
      if (!Array.isArray(content)) continue
      for (const c of content as Record<string, unknown>[]) {
        if (c['type'] === 'text' && typeof c['text'] === 'string' && c['text'].trim()) out.push(`## Prompt${at}`, '', clip(c['text'], 4000), '')
        if (c['type'] === 'tool_result') {
          if (c['is_error']) errors++
          out.push(`${c['is_error'] ? '**Result (error):**' : 'Result:'}`, '', fence(clip(resultText(c['content']))), '')
        }
      }
    } else if (m['type'] === 'assistant' && Array.isArray(content)) {
      for (const c of content as Record<string, unknown>[]) {
        if (c['type'] === 'text' && typeof c['text'] === 'string' && c['text'].trim()) out.push(`**Claude:** ${c['text'].trim()}`, '')
        if (c['type'] === 'tool_use') {
          calls++
          out.push(`### ${String(c['name'])}${at}`, '', fence(clip(JSON.stringify(c['input'] ?? {}, null, 2))), '')
        }
      }
    }
  }
  out.splice(2, 0, `${calls} tool call${calls === 1 ? '' : 's'} · ${errors} error${errors === 1 ? '' : 's'}`, '')
  return out.join('\n')
}
