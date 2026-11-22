// Paths and JSON helpers. Pure: no engine, no file system; the caller reads and writes.

const DIR = 'docs/pipeline'

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** Every project path under <root>/docs/pipeline. */
export function paths(root: string) {
  const dir = `${slashes(root)}/${DIR}`
  return {
    dir,
    config: `${dir}/config.json`,
    rules: `${dir}/rules.md`,
    backlog: `${dir}/backlog.json`,
    backlogMd: `${dir}/BACKLOG.md`,
    specs: `${dir}/specs`,
    plans: `${dir}/plans`,
    ledgers: `${dir}/ledgers`,
    spec: (id: string) => `${dir}/specs/${id}.md`,
    plan: (id: string) => `${dir}/plans/${id}.md`,
    ledger: (id: string) => `${dir}/ledgers/${id}.json`,
    ledgerDir: (id: string) => `${dir}/ledgers/${id}`,
  }
}

/** Where an item's records live: the spec, plan and briefs relative to a checkout, the tool's own files absolute. */
export type Places = { specRel(id: string): string; planRel(id: string): string; briefDir(id: string): string; recordsDir: string; ledger(id: string): string; facts: string; issues: string; items: string; exclude: string }

/**
 * The record locations of a queue mode. File mode keeps everything under docs/pipeline, as before. GitHub mode puts what
 * agents write under .pipeline/ in the checkout and what only the tool writes under .git/pipeline/ of the root.
 */
export function places(root: string, queue: 'file' | 'github'): Places {
  const r = slashes(root)
  if (queue === 'file') {
    const p = paths(root)
    return {
      specRel: id => `${DIR}/specs/${id}.md`,
      planRel: id => `${DIR}/plans/${id}.md`,
      briefDir: id => `${DIR}/ledgers/${id}`,
      recordsDir: DIR,
      ledger: p.ledger,
      facts: `${p.dir}/facts.md`,
      issues: `${r}/.git/pipeline/issues.json`,
      items: `${r}/.git/pipeline/items.json`,
      exclude: `${r}/.git/info/exclude`,
    }
  }
  const tool = `${r}/.git/pipeline`
  return {
    specRel: id => `.pipeline/${id}/spec.md`,
    planRel: id => `.pipeline/${id}/plan.md`,
    briefDir: id => `.pipeline/${id}`,
    recordsDir: '.pipeline',
    ledger: id => `${tool}/${id}/ledger.json`,
    facts: `${tool}/facts.md`,
    issues: `${tool}/issues.json`,
    items: `${tool}/items.json`,
    exclude: `${r}/.git/info/exclude`,
  }
}

/** The first 12 hex characters of the root's SHA-1, for the live file of a project without a repository. */
export async function hashRoot(root: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(slashes(root)))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

/** The live file: under .git with a repository, else under ~/.claude/pipeline named by the root's hash. */
export function livePath(root: string, hasGit: boolean, home: string, hash: string): string {
  return hasGit ? `${slashes(root)}/.git/pipeline-live.json` : `${slashes(home)}/.claude/pipeline/${hash}.json`
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** JSON.parse with the error named as `<file>: line N: <message>`; the line found by the runtime or by a scan of the text. */
export function parseJson<T>(text: string, file: string): Parsed<T> {
  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const line = /line (\d+)/i.exec(message)
    const pos = /position (\d+)/i.exec(message)
    const offset = line ? null : pos ? Number(pos[1]) : firstInvalidOffset(text)
    const n = line ? Number(line[1]) : text.slice(0, offset ?? 0).split('\n').length
    return { ok: false, error: `${file}: line ${n}: ${message}` }
  }
}

/** JSON.stringify with two-space indent and a trailing newline, as every pipeline file is written. */
export function serialize(x: unknown): string {
  return JSON.stringify(x, null, 2) + '\n'
}

/**
 * The offset of the first token JSON would reject: a minimal reader that only tracks position.
 * Used for the error line when the runtime's message carries none; values always come from JSON.parse.
 */
export function firstInvalidOffset(text: string): number {
  let i = 0
  const fail = (at: number): never => {
    throw at
  }
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++
  }
  const literal = (word: string) => (text.startsWith(word, i) ? (i += word.length) : fail(i))
  const string = () => {
    if (text[i] !== '"') return fail(i)
    i++
    for (; i < text.length; i++) {
      const c = text[i]!
      if (c === '"') return i++
      if (c === '\\') {
        const e = text[i + 1]
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail(i)
          i += 5
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i++
        else fail(i)
      } else if (c < ' ') fail(i)
    }
    return fail(i)
  }
  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64))
    return m ? (i += m[0].length) : fail(i)
  }
  const value = (): void => {
    ws()
    const c = text[i]
    if (c === undefined) return fail(i)
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']'
      i++
      ws()
      if (text[i] === close) return void i++
      for (;;) {
        ws()
        if (c === '{') {
          string()
          ws()
          if (text[i] !== ':') fail(i)
          i++
        }
        value()
        ws()
        if (text[i] === close) return void i++
        if (text[i] !== ',') fail(i)
        i++
      }
    }
    if (c === '"') return void string()
    if (c === 't') return void literal('true')
    if (c === 'f') return void literal('false')
    if (c === 'n') return void literal('null')
    if (c === '-' || (c >= '0' && c <= '9')) return void number()
    fail(i)
  }
  try {
    value()
    ws()
    return i < text.length ? i : 0
  } catch (at) {
    return typeof at === 'number' ? at : 0
  }
}
