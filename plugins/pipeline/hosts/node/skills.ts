/**
 * The plugin's skills for a program that does not read a Claude Code plugin: each SKILL.md with its name and
 * description, and the note that says what the Claude Code words in them mean in that program.
 */
import path from 'node:path'

export type Skill = { id: string; name: string; description: string; path: string; content: string }

type Fs = {
  existsSync: (p: string) => boolean
  readFileSync: (p: string, encoding: 'utf8') => string
  readdirSync: (p: string, options: { withFileTypes: true }) => { name: string; isDirectory(): boolean }[]
}

/** The frontmatter's plain `key: value` lines (a value may go on over indented lines) and the text after it. */
export function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  let last = ''
  for (const raw of (m[1] ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    const at = line.indexOf(':')
    if (at > 0 && !/^\s/.test(line)) {
      last = line.slice(0, at).trim()
      const value = line.slice(at + 1).trim()
      fields[last] = /^[>|][+-]?$/.test(value) ? '' : value
    } else if (last && line.trim()) fields[last] = `${fields[last]} ${line.trim()}`.trim()
  }
  for (const k of Object.keys(fields)) fields[k] = (fields[k] ?? '').replace(/^(["'])([\s\S]*)\1$/, '$2')
  return { fields, body: m[2] ?? '' }
}

/** Every `<dir>/<name>/SKILL.md`. */
export function skillsIn(dir: string, fs: Fs): Skill[] {
  if (!fs.existsSync(dir)) return []
  const out: Skill[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const file = path.join(dir, e.name, 'SKILL.md')
    if (!fs.existsSync(file)) continue
    const { fields, body } = frontmatter(fs.readFileSync(file, 'utf8'))
    out.push({ id: e.name, name: fields['name'] || e.name, description: fields['description'] ?? '', path: file, content: body })
  }
  return out
}

/** What the skills' Claude Code words mean in another program. */
export function hostNote(h: { program: string; tool: string; agent: string; shell: string }): string {
  return [
    `## In ${h.program}`,
    '',
    `These skills were written for Claude Code. In ${h.program}:`,
    `- \`mcp__pipeline__pipeline\` is ${h.tool}; its actions and answers are the same.`,
    `- Where a skill or an answer of the tool says to make an \`Agent\` call (\`pipeline:implementer\`, \`pipeline:reviewer\`): ${h.agent}.`,
    `- \`Bash\` is ${h.shell}.`,
    '- There are no `/pipeline` commands, no panel and no watchdog over subagents here: the user asks in words, and the `status` action is the display.',
  ].join('\n')
}
