// Migration parsers: pure functions that read a project's own queue, workflow prose and
// ledgers and draft backlog items, rules.md lines and the active item. No I/O here; the
// tool action in register.tsx reads the files and the skill does the judgment.

import type { Item } from '../types'

export type RuleGroup = 'before dispatch' | 'in every implementer brief' | 'in every reviewer brief' | 'before the PR' | 'after merge'
export type MigrateRule = { group: RuleGroup; line: string; source: string }
export type SourceText = { file: string; text: string }
export type ActiveItem = { id?: string; title: string; status: 'building'; branch: string; plan?: string; ledger: string; resume: { task: number; state: string; lastVerified?: string } }

export const RULE_GROUPS: RuleGroup[] = ['before dispatch', 'in every implementer brief', 'in every reviewer brief', 'before the PR', 'after merge']

const TITLE_MAX = 80
const LINE_MAX = 160

// ---------- text helpers ----------

/** Markdown links become their text, bold markers go, whitespace collapses. */
function stripMd(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The first sentence: up to the first period that ends a word, then at most `max` characters cut at a word boundary. */
function firstSentence(s: string, max = TITLE_MAX): string {
  let t = stripMd(s).split(/\.(?=\s|$)/)[0] ?? ''
  if (t.length > max) {
    const cut = t.lastIndexOf(' ', max)
    t = cut > 0 ? t.slice(0, cut) : t.slice(0, max)
    // A cut inside a parenthesis drops the open group rather than leaving half of it.
    if ((t.match(/\(/g)?.length ?? 0) > (t.match(/\)/g)?.length ?? 0)) t = t.slice(0, t.lastIndexOf('('))
  }
  return t.replace(/[\s,;:]+$/, '').trim()
}

/** A paragraph split into sentences at a period, question or exclamation mark followed by a capital, a backtick or a quote. */
function sentences(paragraph: string): string[] {
  return stripMd(paragraph)
    .split(/(?<=[.!?])\s+(?=[A-Z`"'(])/)
    .map(s => s.trim())
    .filter(s => s.length >= 15)
}

/** A line cut to under `max` characters at a word boundary. */
function oneLine(s: string, max = LINE_MAX): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length < max) return t
  const cut = t.lastIndexOf(' ', max - 1)
  return (cut > 0 ? t.slice(0, cut) : t.slice(0, max - 1)).replace(/[\s,;:]+$/, '')
}

/** The bullet or table-row units of a markdown text, continuation lines joined, with the heading each sits under. */
function units(text: string): { kind: 'bullet' | 'row' | 'other'; text: string; heading: string; rowIndex: number }[] {
  const out: { kind: 'bullet' | 'row' | 'other'; text: string; heading: string; rowIndex: number }[] = []
  let heading = ''
  let rowIndex = 0
  let current: { kind: 'bullet' | 'row' | 'other'; text: string; heading: string; rowIndex: number } | null = null
  const flush = () => { if (current) out.push(current); current = null }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) { flush(); heading = (h[1] ?? '').trim(); rowIndex = 0; continue }
    if (!line.trim()) { flush(); rowIndex = 0; continue }
    if (/^\|/.test(line)) {
      flush()
      out.push({ kind: 'row', text: line, heading, rowIndex })
      rowIndex += 1
      continue
    }
    if (/^(?:[-*+]|\d+\.)\s+/.test(line)) {
      flush()
      current = { kind: 'bullet', text: line.replace(/^(?:[-*+]|\d+\.)\s+/, ''), heading, rowIndex: 0 }
      continue
    }
    if (/^\s+/.test(line) && current) { current.text += ' ' + line.trim(); continue }
    if (current?.kind === 'other') { current.text += ' ' + line.trim(); continue }
    flush()
    current = { kind: 'other', text: line.trim(), heading, rowIndex: 0 }
  }
  flush()
  return out
}

// ---------- sources ----------

const QUEUE_WORD = /\b(queue|status|workflow|ledger|backlog)\b/i

/** The spec's candidate source files that are present in `listing`, in the spec's order. */
export function findSources(listing: string[], claudeMd: string): string[] {
  const present = new Set(listing.map(p => p.replace(/^\.\//, '')))
  const out: string[] = []
  const add = (p: string) => { if (present.has(p) && !out.includes(p)) out.push(p) }
  const addMatching = (test: (p: string) => boolean) => { for (const p of present) if (test(p)) add(p) }

  add('CLAUDE.md')
  addMatching(p => p.endsWith('/CLAUDE.md'))
  for (const p of ['docs/WORKFLOW.md', 'docs/backlog.md', 'docs/SLICES.md']) add(p)
  const link = /\[([^\]]*)\]\(([^)\s#]+)[^)]*\)/g
  for (const m of claudeMd.matchAll(link)) {
    const target = (m[2] ?? '').replace(/^\.\//, '')
    if (/^[a-z]+:/i.test(target)) continue
    const rest = claudeMd.slice((m.index ?? 0) + m[0].length)
    const after = rest.slice(0, rest.indexOf('\n') < 0 ? 120 : Math.min(120, rest.indexOf('\n')))
    if (!QUEUE_WORD.test(m[1] ?? '') && !QUEUE_WORD.test(after)) continue
    if (target.endsWith('/')) addMatching(p => p.startsWith(target))
    else add(target)
  }
  addMatching(p => /^docs\/superpowers\/specs\/[^/]+$/.test(p))
  addMatching(p => /^docs\/superpowers\/plans\/[^/]+$/.test(p))
  addMatching(p => /^\.superpowers\/sdd\/(?:.*\/)?progress\.md$/.test(p))
  addMatching(p => /^docs\/superpowers\/ledgers\/[^/]+$/.test(p))
  addMatching(p => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(p))
  add('Makefile')
  add('package.json')
  addMatching(p => /^\.github\/workflows\/[^/]+$/.test(p))
  return out
}

// ---------- the catalo backlog shape ----------

const PR_LINK = /https?:\/\/\S+?\/pull\/\d+/
const DEFERRED = /\b(later|V1|phase 2)\b/i
const FOLLOW_UPS = /^named follow-ups\b/i

/** Backlog items from a markdown queue of `- [ ]` / `- [x]` items and "Named follow-ups" lists or tables, in document order. */
export function itemsFromBacklogMd(text: string, file: string): Partial<Item>[] {
  const out: Partial<Item>[] = []
  const unverified = `imported from ${file}, unverified`
  for (const u of units(text)) {
    const source = `${file}: ${u.heading}`
    if (u.kind === 'bullet') {
      const box = /^\[([ xX])\]\s+(.*)$/s.exec(u.text)
      if (box) {
        const body = box[2] ?? ''
        const title = firstSentence(body)
        if (!title) continue
        if (box[1] !== ' ') {
          const pr = PR_LINK.exec(body)?.[0]
          out.push(pr
            ? { title, status: 'merged', pr, source, note: `imported from ${file}` }
            : { title, status: 'merged', source, note: `imported from ${file}; no PR link` })
          continue
        }
        const deferred = DEFERRED.test(title) || /\((?:later|V1|phase 2)\)|\b(?:deferred|moved|parked)\s+(?:to|for)\s+(?:later|V1|phase 2)\b/i.test(body)
        out.push({ title, status: deferred ? 'parked' : 'inbox', source, note: unverified })
        continue
      }
      if (FOLLOW_UPS.test(u.heading)) {
        const title = firstSentence(u.text)
        if (title) out.push({ title, status: 'inbox', source, note: unverified })
      }
      continue
    }
    if (u.kind === 'row' && FOLLOW_UPS.test(u.heading)) {
      if (u.rowIndex === 0 || /^\|\s*:?-{2,}/.test(u.text)) continue
      const cells = u.text.split('|').slice(1, -1).map(c => stripMd(c))
      const title = firstSentence(cells[0] ?? '')
      if (!title) continue
      const detail = firstSentence(cells[1] ?? '', LINE_MAX)
      out.push({ title, status: 'inbox', source, note: detail ? `${unverified}. ${detail}` : unverified })
    }
  }
  return out
}

// ---------- the openhuddle MVP queue shape ----------

/** The top-level parenthesised groups of a text, as [start, end) offsets. */
function parenGroups(s: string): [number, number][] {
  const groups: [number, number][] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') { if (depth === 0) start = i; depth += 1 }
    else if (c === ')' && depth > 0) { depth -= 1; if (depth === 0) groups.push([start, i + 1]) }
  }
  return groups
}

const ENTRY = /\*\*(Q\d+)\b([^*]*)\*\*/g

/** One inbox item per `**Qn**` queue entry under an "MVP queue" heading, in order, with the rows it closes and its needs. */
export function itemsFromMvpQueue(text: string, file: string): Partial<Item>[] {
  const out: Partial<Item>[] = []
  for (const u of units(text)) {
    if (!/\bMVP queue\b/i.test(u.heading) || u.kind === 'row') continue
    const markers = [...u.text.matchAll(ENTRY)]
    if (markers.length === 0) continue
    const label = u.text.slice(0, markers[0]?.index ?? 0).replace(/[:\s]+$/, '').trim()
    const source = `${file}: ${u.heading}${label ? `, ${label}` : ''}`
    markers.forEach((m, k) => {
      const id = m[1] ?? ''
      const bold = (m[2] ?? '').trim()
      const from = (m.index ?? 0) + m[0].length
      const to = k + 1 < markers.length ? (markers[k + 1]?.index ?? u.text.length) : u.text.length
      const entry = (bold ? bold + ' ' : '') + u.text.slice(from, to).trim()
      const groups = parenGroups(entry)
      const meta = [...groups].reverse().find(([a, b]) => /\brows?\s+\d/.test(entry.slice(a, b)))
      const inner = meta ? entry.slice(meta[0] + 1, meta[1] - 1) : ''
      let bare = ''
      let last = 0
      for (const [a, b] of groups) { bare += entry.slice(last, a); last = b }
      bare += entry.slice(last)
      const title = firstSentence(bare) || id
      const rows = /\brows?\s+([\d\s,]+)/.exec(inner)?.[1]?.split(/[\s,]+/).filter(Boolean) ?? []
      const needs = [...(/\bneeds\s+([^;)]*)/.exec(inner)?.[1] ?? '').matchAll(/\bQ\d+\b/g)].map(x => x[0])
      const size = /;\s*([SML])\b[^;]*$/.exec(inner)?.[1] as Item['size'] | undefined
      const closes = rows.length ? `closes ${rows.length === 1 ? 'row' : 'rows'} ${rows.join(', ')}; ` : ''
      out.push({
        id, title, status: 'inbox', source,
        ...(needs.length ? { needs } : {}),
        ...(size ? { size } : {}),
        note: `${closes}imported from ${file}, unverified`,
      })
    })
  }
  return out
}

// ---------- rules from prose ----------

const ENV_VAR = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/
const AFTER_MERGE = /\bafter (?:each|every) (?:merge|merged|completed)\b/i
const BROWSER = /\b(?:browser|playwright)\b/i
const ACCOUNT = /\b(?:test account|sign[ -]?up|credentials)\b/i
const STANDING = /\bstanding user instruction\b|\bnever\b|\bonly one\b|\balways\b.*\bbefore\b/i
const STOP_LIST = /\b(?:stop and ask|ask the user only|ask only (?:when|for))\b/i
const PR_VERB = /\b(?:merge[sd]?|merging|PRs?|pull requests?|push(?:es|ed)?|commits?|committed)\b/

/** Candidate rules.md lines from workflow prose, grouped by when they apply, each with its source file. */
export function rulesFromProse(texts: SourceText[]): MigrateRule[] {
  const out: MigrateRule[] = []
  const seen = new Set<string>()
  const push = (group: RuleGroup, line: string, source: string) => {
    const key = `${group}\n${line}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ group, line, source })
  }
  for (const { file, text } of texts) {
    for (const u of units(text)) {
      if (u.kind === 'row') continue
      const paragraphVar = ENV_VAR.exec(u.text)?.[0]
      for (const s of sentences(u.text)) {
        if (STOP_LIST.test(s)) continue
        if (AFTER_MERGE.test(s)) { push('after merge', oneLine(s), file); continue }
        if (/\bskip/i.test(s) && (ENV_VAR.test(s) || paragraphVar)) {
          const suffix = ENV_VAR.test(s) ? '' : ` (${paragraphVar})`
          const line = oneLine(s, LINE_MAX - suffix.length).replace(/\.$/, '') + suffix + '.'
          push('in every reviewer brief', line, file)
          push('before the PR', line, file)
          continue
        }
        if (BROWSER.test(s) || ACCOUNT.test(s)) { push('in every implementer brief', oneLine(s), file); continue }
        if (STANDING.test(s)) push(PR_VERB.test(s) ? 'before the PR' : 'before dispatch', oneLine(s), file)
      }
    }
  }
  return out
}

/** The rules.md text: a heading per group in order, lines numbered through the file, each ending with its source. */
export function renderRulesMd(rules: MigrateRule[]): string {
  const lines = ['# Rules', '', 'Process rules the config cannot express, by when they apply. The run skill pastes each group into the brief or step it names.', '']
  let n = 0
  for (const group of RULE_GROUPS) {
    lines.push(`## ${group[0]?.toUpperCase()}${group.slice(1)}`, '')
    const own = rules.filter(r => r.group === group)
    for (const r of own) lines.push(`${++n}. ${r.line} (${r.source})`)
    if (own.length) lines.push('')
  }
  return lines.join('\n')
}

// ---------- the active item ----------

const STATUS_HEADING = /^(#{1,6})\s+current status\b.*$/im
const SHA = /\b(?:tested at commit|verified at(?: commit)?|at commit|commit)\s+`?([0-9a-f]{7,40})\b`?/i

/** The current-status block of a ledger: the text under a "Current status" heading up to the next heading of its level or higher. */
function statusBlock(text: string): string | null {
  const m = STATUS_HEADING.exec(text)
  if (!m) return null
  const level = (m[1] ?? '#').length
  const rest = text.slice((m.index ?? 0) + m[0].length)
  const next = new RegExp(`^#{1,${level}}\\s`, 'm').exec(rest)
  return rest.slice(0, next ? next.index : rest.length)
}

/** A building item per open `feat/<x>` branch that has a ledger with a current-status block, with `resume` read from that block. */
export function activeFromBranches(branches: string[], ledgers: SourceText[]): ActiveItem[] {
  const out: ActiveItem[] = []
  for (const branch of branches) {
    const m = /^feat\/(.+)$/.exec(branch.trim())
    if (!m) continue
    const x = m[1] ?? ''
    const ledger = ledgers.find(l => l.text.includes(branch) || l.file.includes(x))
    if (!ledger) continue
    const block = statusBlock(ledger.text)
    if (!block?.trim()) continue
    const flat = block.split('\n').map(l => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim()).filter(Boolean).join(' ')
    const task = Number(/\bTask (\d+)\b/.exec(flat)?.[1] ?? 1)
    const state = oneLine(firstSentence(flat, LINE_MAX))
    const lastVerified = SHA.exec(flat)?.[1]
    const h1 = /^#\s+(.*)$/m.exec(ledger.text)?.[1]?.trim() ?? ''
    const plan = /\bplan:\s*(\S+\.md)/i.exec(h1)?.[1]
    const isId = /^p\d+$/.test(x)
    out.push({
      ...(isId ? { id: x } : {}),
      title: isId ? (stripMd(h1) || x) : x.replace(/[-_]+/g, ' '),
      status: 'building',
      branch,
      ...(plan ? { plan } : {}),
      ledger: ledger.file,
      resume: { task, state, ...(lastVerified ? { lastVerified } : {}) },
    })
  }
  return out
}

// ---------- history ----------

/** The line prepended to each old queue and ledger file. */
export function historicalLine(date: string): string {
  return `Historical. The queue is docs/pipeline/backlog.json since ${date}.`
}
