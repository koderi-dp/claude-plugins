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
const LINE_MAX = 200
const SENTENCE_MAX = 240

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

/** A line under `max` characters: whole when it is, else its first sentence when that is under `SENTENCE_MAX`, else cut at a word boundary. */
function oneLine(s: string, max = LINE_MAX): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length < max) return t
  const first = t.split(/(?<=[.!?])\s+/)[0] ?? ''
  if (first.length < SENTENCE_MAX) return first
  const cut = t.lastIndexOf(' ', max - 1)
  return (cut > 0 ? t.slice(0, cut) : t.slice(0, max - 1)).replace(/[\s,;:]+$/, '')
}

type Unit = { kind: 'bullet' | 'row' | 'other'; text: string; heading: string; section: number; rowIndex: number }

/** The bullet or table-row units of a markdown text, continuation lines joined and nested bullets their own units, with the heading and the section number each sits under. */
function units(text: string): Unit[] {
  const out: Unit[] = []
  let heading = ''
  let section = 0
  let rowIndex = 0
  let current: Unit | null = null
  const flush = () => { if (current) out.push(current); current = null }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) { flush(); heading = (h[1] ?? '').trim(); section += 1; rowIndex = 0; continue }
    if (!line.trim()) { flush(); rowIndex = 0; continue }
    if (/^\|/.test(line)) {
      flush()
      out.push({ kind: 'row', text: line, heading, section, rowIndex })
      rowIndex += 1
      continue
    }
    const bullet = /^\s*(?:[-*+]|\d+\.)\s+/.exec(line)
    if (bullet) {
      flush()
      current = { kind: 'bullet', text: line.slice(bullet[0].length), heading, section, rowIndex: 0 }
      continue
    }
    if (/^\s+/.test(line) && current) { current.text += ' ' + line.trim(); continue }
    if (current?.kind === 'other') { current.text += ' ' + line.trim(); continue }
    flush()
    current = { kind: 'other', text: line.trim(), heading, section, rowIndex: 0 }
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
const DEFERRED_HEADING = /\blater\b|\bphases?\s+[2-9]\b/i
const FOLLOW_UPS = /^named follow-ups\b/i
const WORK_HEADER = /\b(?:work|scope)\b/i
const STATUS_OF: Record<string, Item['status']> = { done: 'merged', queued: 'inbox', later: 'parked' }
const RULE_ROW = /^\|\s*:?-{2,}/

/** The first spec and the first plan a bullet links (`.../specs/x.md`, `.../plans/x.md`), resolved against the queue file's folder. */
function linksOf(body: string, file: string): { spec?: string; plan?: string } {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : ''
  const out: { spec?: string; plan?: string } = {}
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s#]+\.md)[^)]*\)/g)) {
    const raw = m[1] ?? ''
    if (/^[a-z]+:/i.test(raw)) continue
    const target = raw.startsWith('/') ? raw.slice(1) : raw.startsWith('./') ? dir + raw.slice(2) : raw.startsWith('../') ? raw.replace(/^(\.\.\/)+/, '') : dir + raw
    if (!out.spec && /\/specs\//.test(target)) out.spec = target
    else if (!out.plan && /\/plans\//.test(target)) out.plan = target
  }
  return out
}

/** The cells of a table row, markdown stripped. */
const cellsOf = (row: string) => row.split('|').slice(1, -1).map(c => stripMd(c))

/**
 * Backlog items from a markdown queue, in document order: `- [ ]` / `- [x]` bullets; the rows of a table with a `Status`
 * column (Done is merged, Later parked, the rest inbox; the first cell is the title, the third the note); the rows of a
 * table whose second column names work or scope, or that sits under a "Named follow-ups" heading (Done or Delivered rows
 * merged, Implemented rows dropped, the rest parked under a later-phases heading and inbox elsewhere); and the plain
 * bullets of a "Named follow-ups" section that has no table.
 */
export function itemsFromBacklogMd(text: string, file: string): Partial<Item>[] {
  const out: Partial<Item>[] = []
  const unverified = `imported from ${file}, unverified`
  const merged = (title: string, body: string, source: string, links: { spec?: string; plan?: string }): Partial<Item> => {
    const pr = PR_LINK.exec(body)?.[0]
    return pr
      ? { title, status: 'merged', pr, source, ...links, note: `imported from ${file}` }
      : { title, status: 'merged', source, ...links, note: `imported from ${file}; no PR link` }
  }
  const all = units(text)
  const sectionsWithTable = new Set(all.filter(u => u.kind === 'row').map(u => u.section))
  // The shape of the table being read, from its header row: the index of its Status column, or whether it lists work.
  let table: { status: number; work: boolean } | null = null
  for (const u of all) {
    const source = `${file}: ${u.heading}`
    if (u.kind === 'bullet') {
      const box = /^\[([ xX])\]\s+(.*)$/s.exec(u.text)
      if (box) {
        const body = box[2] ?? ''
        const title = firstSentence(body)
        if (!title) continue
        const links = linksOf(body, file)
        if (box[1] !== ' ') {
          out.push(merged(title, body, source, links))
          continue
        }
        const deferred = DEFERRED.test(title) || /\((?:later|V1|phase 2)\)|\b(?:deferred|moved|parked)\s+(?:to|for)\s+(?:later|V1|phase 2)\b/i.test(body)
        out.push({ title, status: deferred ? 'parked' : 'inbox', source, ...links, note: unverified })
        continue
      }
      if (FOLLOW_UPS.test(u.heading) && !sectionsWithTable.has(u.section)) {
        const title = firstSentence(u.text)
        if (title) out.push({ title, status: 'inbox', source, note: unverified })
      }
      continue
    }
    if (u.kind !== 'row') continue
    if (u.rowIndex === 0) {
      const header = cellsOf(u.text).map(c => c.toLowerCase())
      table = { status: header.indexOf('status'), work: WORK_HEADER.test(header[1] ?? '') || FOLLOW_UPS.test(u.heading) }
      continue
    }
    if (!table || RULE_ROW.test(u.text)) continue
    const cells = cellsOf(u.text)
    const title = firstSentence(cells[0] ?? '')
    if (!title) continue
    if (table.status >= 0) {
      const status = STATUS_OF[(cells[table.status] ?? '').toLowerCase()] ?? 'inbox'
      const links = linksOf(u.text, file)
      if (status === 'merged') {
        out.push(merged(title, u.text, source, links))
        continue
      }
      const detail = firstSentence(cells[2] ?? cells[1] ?? '', LINE_MAX)
      out.push({ title, status, source, ...links, note: detail ? `${unverified}. ${detail}` : unverified })
      continue
    }
    if (!table.work) continue
    const detail = firstSentence(cells[1] ?? '', LINE_MAX)
    if (/^Implemented\b/.test(detail)) continue
    if (/^(?:Done|Delivered)\b/.test(detail)) {
      out.push(merged(title, u.text, source, {}))
      continue
    }
    const status = DEFERRED_HEADING.test(u.heading) ? 'parked' : 'inbox'
    out.push({ title, status, source, note: detail ? `${unverified}. ${detail}` : unverified })
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
const STOP_LIST = /\b(?:stop and ask|ask the user only|ask only (?:when|for))\b|\bdo not\b.*\bwithout asking\b/i
const PR_VERB = /\b(?:merge[sd]?|merging|PRs?|pull requests?|push(?:es|ed)?|commits?|committed)\b/
const DISPATCH = /\bbefore dispatch\b|\bindependent review\b|\bworktrees?\b/i
const SEARCH_FIRST = /\bsearch existing\b/i
const VERIFY = /\bverify\b/i
const WHEN_CHANGED = /\bwhen (?:the )?\w+ changed\b/i
const RULE_MIN = 30
const LABEL_DATE = /^[\w\s]+\(\d{4}-\d{2}-\d{2}\)\.?$/
const COMMAND_DOC = /^`[^`]+`\s*(?:[—–:-]|$)/
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/

/**
 * Candidate rules.md lines from workflow prose, grouped by when they apply, each with its source file. Config material
 * (stop lists), sentences under 30 characters, a label with a date, a list label ending in a colon, the sentence that
 * documents a command and a skill's front matter are left out.
 */
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
    for (const u of units(text.replace(FRONTMATTER, ''))) {
      if (u.kind === 'row') continue
      const paragraphVar = ENV_VAR.exec(u.text)?.[0]
      for (const s of sentences(u.text)) {
        if (STOP_LIST.test(s) || s.length < RULE_MIN || LABEL_DATE.test(s) || s.endsWith(':') || COMMAND_DOC.test(s)) continue
        if (AFTER_MERGE.test(s)) { push('after merge', oneLine(s), file); continue }
        if (/\bskip/i.test(s) && (ENV_VAR.test(s) || paragraphVar)) {
          const suffix = ENV_VAR.test(s) ? '' : ` (${paragraphVar})`
          const line = oneLine(s, LINE_MAX - suffix.length).replace(/\.$/, '') + suffix + '.'
          push('in every reviewer brief', line, file)
          push('before the PR', line, file)
          continue
        }
        if (BROWSER.test(s) || ACCOUNT.test(s) || SEARCH_FIRST.test(s)) { push('in every implementer brief', oneLine(s), file); continue }
        if (DISPATCH.test(s)) { push('before dispatch', oneLine(s), file); continue }
        if (VERIFY.test(s)) { push('in every reviewer brief', oneLine(s), file); continue }
        if (WHEN_CHANGED.test(s)) { push('before the PR', oneLine(s), file); continue }
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

// ---------- the bulk of merged increments ----------

const SDD = '.superpowers/sdd/'
const KEPT = /^(?:progress\.md|final-review[^/]*)$/i
const STOP_WORDS = new Set(['and', 'the', 'of', 'for', 'with', 'from', 'to', 'in', 'on', 'a', 'an', 'slice', 'part', 'phase'])

const trimPath = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')

/** The words of a folder name or a title that carry meaning: lower case, the date prefix and short or common words dropped. */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
}

export type Increment = { dir: string; pointer: string }

/**
 * Which `.superpowers/sdd/<dir>` folders belong to merged items: `merged` when the folder's pointer (its `plan-path`
 * file or its progress.md header) names a merged item's plan exactly; `unsure` when only the folder's words all appear
 * in a merged item's title. Any other folder is left alone.
 */
export function incrementsOf(increments: Increment[], items: Partial<Item>[]): { merged: string[]; unsure: string[] } {
  const merged: string[] = []
  const unsure: string[] = []
  const done = items.filter(i => i.status === 'merged')
  const plans = new Set(done.map(i => (typeof i.plan === 'string' ? trimPath(i.plan) : '')).filter(Boolean))
  for (const inc of increments) {
    const named = inc.pointer.split(/\s+/).map(trimPath).filter(p => p.endsWith('.md'))
    if (named.some(p => plans.has(p))) {
      merged.push(inc.dir)
      continue
    }
    const own = words(inc.dir)
    if (own.length && done.some(i => { const t = new Set(words(i.title ?? '')); return own.every(w => t.has(w)) })) unsure.push(inc.dir)
  }
  return { merged, unsure }
}

/** The files under `.superpowers/sdd/<increment>/` of the merged increments, except `progress.md` and `final-review*.md`, with their count. */
export function bulkToRemove(listing: string[], mergedIncrements: string[]): { files: string[]; count: number } {
  const dirs = new Set(mergedIncrements.map(d => trimPath(d).replace(/\/+$/, '')))
  const files: string[] = []
  for (const raw of listing) {
    const p = trimPath(raw)
    if (!p.startsWith(SDD) || p.endsWith('/')) continue
    const rest = p.slice(SDD.length)
    const dir = rest.split('/')[0] ?? ''
    if (!dirs.has(dir) || dir === rest) continue
    if (KEPT.test(rest.split('/').pop() ?? '')) continue
    if (!files.includes(p)) files.push(p)
  }
  return { files, count: files.length }
}

