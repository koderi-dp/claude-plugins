// The plan of an item and the briefs rendered from it. Pure: the caller reads the plan, the spec, the rules and the
// ledger and writes the brief; this parses, checks and fills. The plan format is the one the run skill gives the lead.

import type { Config, Ledger } from '../types'
import { matchesGlob } from './watch'
import { TEMPLATES } from './templates'
import type { BriefKind } from './templates'

export type PlanTask = { n: number; title: string; files: string[]; pinned: string; needs: number[]; covers: number[]; check: string; commit: string; focus: string; body: string }
export type Plan = { title: string; constraints: string; parked: string; tasks: PlanTask[] }

const TASK = /^###\s+Task\s+(\d+)\s*[:.—-]?\s*(.*)$/i
const FIELD = /^\s*[-*]\s+\*{0,2}(Files|Pinned|Needs|Covers|Check|Commit|Focus)\*{0,2}\s*:\*{0,2}\s*(.*)$/i

const unquote = (s: string) => s.trim().replace(/^`+|`+$/g, '').trim()
const list = (s: string) => s.split(/[,;]/).map(unquote).filter(x => x && !/^(none|nothing|-|—)$/i.test(x))

/** The text under a `## <name>` heading, up to the next heading of level 1 to 3; empty when the heading is absent. */
export function section(text: string, name: string): string {
  const lines = text.split('\n')
  const head = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
  const at = lines.findIndex(l => head.test(l))
  if (at < 0) return ''
  const out: string[] = []
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,3}\s/.test(l)) break
    out.push(l)
  }
  return out.join('\n').trim()
}

/** The plan as data: the title, the Constraints and Parked sections, and each `### Task N: title` with its field lines. */
export function parsePlan(text: string): Plan {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const title = (/^#\s+(.*)$/m.exec(text)?.[1] ?? '').trim()
  const tasks: PlanTask[] = []
  let current: PlanTask | null = null
  let body: string[] = []
  const close = () => {
    if (current) {
      current.body = body.join('\n').trim()
      tasks.push(current)
    }
    current = null
    body = []
  }
  for (const l of lines) {
    const t = TASK.exec(l)
    if (t) {
      close()
      current = { n: Number(t[1]), title: (t[2] ?? '').trim(), files: [], pinned: '', needs: [], covers: [], check: '', commit: '', focus: '', body: '' }
      continue
    }
    if (!current) continue
    if (/^#{1,2}\s/.test(l)) {
      close()
      continue
    }
    body.push(l)
    const f = FIELD.exec(l)
    if (!f) continue
    const key = f[1]!.toLowerCase()
    const value = (f[2] ?? '').trim()
    if (key === 'files') current.files = list(value)
    else if (key === 'needs') current.needs = (value.match(/\d+/g) ?? []).map(Number)
    else if (key === 'covers') current.covers = [...new Set((value.match(/\d+/g) ?? []).map(Number))]
    else if (key === 'pinned') current.pinned = value
    else if (key === 'check') current.check = unquote(value)
    else if (key === 'commit') current.commit = unquote(value)
    else if (key === 'focus') current.focus = value
  }
  close()
  return { title, constraints: section(text, 'Constraints'), parked: section(text, 'Parked'), tasks }
}

/** What stops a plan from being built: no task, numbers that are not 1 to N in order, a task without files, a need that is not an earlier task. */
export function checkPlan(plan: Plan): string[] {
  const problems: string[] = []
  if (!plan.tasks.length) return ['no `### Task N: <title>` heading']
  plan.tasks.forEach((t, i) => {
    if (t.n !== i + 1) problems.push(`task ${t.n} is at position ${i + 1}: number the tasks 1 to ${plan.tasks.length} in order`)
    if (!t.title) problems.push(`task ${t.n} has no title`)
    if (!t.files.length) problems.push(`task ${t.n} has no \`- Files:\` line`)
    for (const need of t.needs) if (need >= t.n || need < 1) problems.push(`task ${t.n} needs task ${need}, which is not an earlier task`)
  })
  return problems
}

const ITEM = /^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/

/**
 * The acceptance items of a spec, in order: each list line under `## Acceptance`, a wrapped line joined to its item.
 * A task's `Covers` line and the plan's Parked section name them by their place, counted from 1.
 */
export function acceptanceItems(specMd: string): string[] {
  const items: string[] = []
  let isOpen = false
  for (const l of section(specMd.replace(/\r\n/g, '\n'), 'Acceptance').split('\n')) {
    const m = ITEM.exec(l)
    if (m) {
      items.push((m[1] ?? '').trim())
      isOpen = true
    } else if (!l.trim()) isOpen = false
    else if (isOpen && /^\s+\S/.test(l)) items[items.length - 1] += ` ${l.trim()}`
    else isOpen = false
  }
  return items.filter(Boolean)
}

/** The acceptance items the plan leaves out on purpose: each `Acceptance N` (or `Acceptance 2, 4`) under Parked. */
export function parkedAcceptance(plan: Plan): number[] {
  const out: number[] = []
  for (const m of plan.parked.matchAll(/acceptance\s+#?(\d+(?:\s*(?:,|and|&)\s*#?\d+)*)/gi)) out.push(...(m[1]!.match(/\d+/g) ?? []).map(Number))
  return [...new Set(out)]
}

/** The tasks that claim each acceptance item, by the item's number. */
function claims(plan: Plan): Map<number, number[]> {
  const by = new Map<number, number[]>()
  for (const t of plan.tasks) for (const n of t.covers) by.set(n, [...(by.get(n) ?? []), t.n])
  return by
}

const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`)

/**
 * What the plan leaves of the spec's acceptance: an item no task covers and the plan does not park, and a number the
 * spec does not have. Nothing when the spec lists no acceptance.
 */
export function checkCoverage(plan: Plan, items: string[]): string[] {
  if (!items.length) return []
  const problems: string[] = []
  for (const t of plan.tasks) for (const n of t.covers) if (n < 1 || n > items.length) problems.push(`task ${t.n} covers acceptance ${n}, and the spec has ${items.length}`)
  const by = claims(plan)
  const parked = new Set(parkedAcceptance(plan))
  items.forEach((text, i) => {
    if (!by.has(i + 1) && !parked.has(i + 1)) problems.push(`acceptance ${i + 1} is covered by no task: "${cut(text, 80)}"`)
  })
  return problems
}

/** The numbers of the acceptance items no task covers and the plan does not park. */
export function uncovered(plan: Plan, items: string[]): number[] {
  const by = claims(plan)
  const parked = new Set(parkedAcceptance(plan))
  return items.map((_, i) => i + 1).filter(n => !by.has(n) && !parked.has(n))
}

export const PRINCIPLES_FILE = 'docs/pipeline/principles.md'
export const PRINCIPLES_MAX = 15

/**
 * The project's principles as a brief carries them: the list lines of principles.md, comments and prose left out,
 * the first fifteen with a pointer to the file for the rest. A brief is read on every step, so the list stays short.
 */
export function principlesOf(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n').map(l => l.trim()).filter(l => ITEM.test(l))
  if (!lines.length) return `none written (${PRINCIPLES_FILE})`
  const more = lines.length - PRINCIPLES_MAX
  return [...lines.slice(0, PRINCIPLES_MAX), ...(more > 0 ? [`… and ${more} more in ${PRINCIPLES_FILE}`] : [])].join('\n')
}

/** The starter principles.md that init writes: only commented examples, so a brief reads none until the user writes one. */
export const PRINCIPLES_STARTER = `# Principles

How this project wants its code. The pipeline pastes this list into every implementer and reviewer brief (the first ${PRINCIPLES_MAX} lines), so keep it short, and write only what a formatter or a check cannot enforce.

<!-- Examples; replace them with your own, one per line, outside this comment:
- No new dependency without asking.
- Every calculation with money has a test.
-->
`

/** The numbered lines under a rules.md group heading (`## In every implementer brief`), or `none`. */
export function rulesGroup(rulesMd: string, group: string): string {
  return section(rulesMd, group) || 'none'
}

/** The files of `changed` that match a risky glob, first match per file. */
export function riskyMatches(changed: string[], globs: string[]): string[] {
  return changed.filter(f => globs.some(g => matchesGlob(f, g)))
}

const DIR = 'docs/pipeline/ledgers'

/** The brief and report paths of a dispatch, by the names the ledger folder uses. `round` is the fix round, or the review's (1 is the first). `dir` is the folder the brief goes in, `docs/pipeline/ledgers/<item>` by default. */
export function briefPaths(item: string, kind: BriefKind, task: number, round: number, dir = `${DIR}/${item}`): { brief: string; report: string } {
  const base =
    kind === 'implementer' ? `task-${task}`
    : kind === 'fix' ? `task-${task}-fix-${round}`
    : kind === 'review' ? (round > 1 ? `task-${task}-review-${round}` : `task-${task}-review`)
    : round > 1 ? `final-review-${round}` : 'final'
  return { brief: `${dir}/${base}-brief.md`, report: `${dir}/${base}-report.md` }
}

/** The template with every `{{name}}` filled; a name without a value is left out of the text and named in `missing`. */
export function fill(template: string, values: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const v = values[name]
    if (v === undefined) {
      if (!missing.includes(name)) missing.push(name)
      return ''
    }
    return v
  })
  return { text, missing }
}

export type BriefInput = {
  kind: BriefKind
  item: string
  itemTitle: string
  task: number
  round: number
  plan: Plan
  config: Config
  ledger: Ledger
  rulesMd: string
  factsMd?: string
  /** The text of docs/pipeline/principles.md, when the project has one. */
  principlesMd?: string
  /** The worktree's absolute path: the report is named by its full path, so a subagent never composes one. */
  root?: string
  specMd: string
  template?: string
  findings?: string
  carried?: string
  commits?: string
  risky?: string[]
  head?: string
  attribution?: string
  isEscalated?: boolean
  /** Where the item's records are, relative to the worktree; absent means the file-mode paths under docs/pipeline. */
  places?: { specRel: string; planRel: string; recordsDir: string; briefDir: string }
}

/**
 * The attribution lines a session was given, by where each belongs: a git trailer (`Co-Authored-By: Name <mail>`,
 * a key with a hyphen) ends a commit message, every other line (the "Generated with" link) ends a pull request's
 * text. A lead that describes the lines in a sentence instead of passing them is read for the trailers it quotes,
 * and the sentence itself goes nowhere.
 */
export function splitAttribution(text: string): { trailers: string[]; rest: string[] } {
  const trailers: string[] = []
  const rest: string[] = []
  for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    if (/^[A-Za-z]+(?:-[A-Za-z]+)+: \S/.test(line)) trailers.push(line)
    else {
      const quoted = line.match(/[A-Za-z]+(?:-[A-Za-z]+)+: [^"<>]+<[^<>\s]+>/g)
      if (quoted) trailers.push(...quoted)
      else rest.push(line)
    }
  }
  return { trailers: [...new Set(trailers)], rest }
}

/**
 * The `-m` arguments of a commit: the message without the lines that belong to a pull request, then the trailers
 * the message does not carry yet, so a lead that already ended its message with them writes none twice.
 */
export function commitArgs(message: string, attribution: string): string[] {
  const { trailers, rest } = splitAttribution(attribution)
  const kept = message.split(/\r?\n/).filter(l => !rest.includes(l.trim()))
  const has = new Set(kept.map(l => l.trim().toLowerCase()))
  const missing = trailers.filter(t => !has.has(t.toLowerCase()))
  return ['-m', kept.join('\n').trim(), ...(missing.length ? ['-m', missing.join('\n')] : [])]
}

const or = (s: string | undefined, fallback: string) => (s && s.trim() ? s.trim() : fallback)

/** One brief, filled: its text, its two paths, and the model and effort the config gives the role. Throws with what is missing. */
export function renderBrief(input: BriefInput): { text: string; brief: string; report: string; model: string; effort: string; role: string } {
  const { kind, item, plan, config: c, ledger } = input
  const task = plan.tasks.find(t => t.n === input.task)
  if (kind !== 'final' && !task) throw new Error(`the plan has no task ${input.task}`)
  const at = input.places ?? { specRel: `docs/pipeline/specs/${item}.md`, planRel: `docs/pipeline/plans/${item}.md`, recordsDir: 'docs/pipeline', briefDir: `${DIR}/${item}` }
  const paths = briefPaths(item, kind, input.task, input.round, at.briefDir)
  const others = plan.tasks.filter(t => t.n !== input.task).flatMap(t => t.files).filter(f => !task?.files.includes(f))
  const role = kind === 'review' ? 'reviewer' : kind === 'final' ? 'final' : 'implementer'
  const m = c.models[input.isEscalated && role === 'implementer' ? 'escalate' : role]
  const accepted = acceptanceItems(input.specMd)
  const values: Record<string, string> = {
    item,
    title: kind === 'final' ? input.itemTitle : task!.title,
    n: String(input.task),
    total: String(plan.tasks.length),
    report: input.root ? `${input.root.replace(/\/+$/, '')}/${paths.report}` : paths.report,
    constraints: or(plan.constraints, 'none'),
    checkFast: or(c.checks.fast, 'the focused tests of the files you touch'),
    checkTask: or(task?.check, or(c.checks.task, 'the tests of the package you touch')),
    checkGate: or(c.checks.gate, 'the full test suite'),
    process: c.superpowers === 'on' ? 'A skill the session has for testing, debugging or verification may be used inside a step; this brief decides what is done.' : 'This brief is the whole process: invoke no skill (no superpowers skill, no planning or brainstorming skill) and dispatch no agent.',
    facts: (input.factsMd ?? '').split('\n').filter(l => /^[-*]\s/.test(l)).join('\n') || 'none yet',
    spec: at.specRel,
    plan: at.planRel,
    records: at.recordsDir,
    worktree: input.root ? input.root.replace(/\/+$/, '') : 'the folder this brief is in the records of',
    principles: principlesOf(input.principlesMd ?? ''),
    attribution: or(splitAttribution(input.attribution ?? (typeof ledger['attribution'] === 'string' ? (ledger['attribution'] as string) : '')).trailers.join('\n'), '(no attribution lines)'),
  }
  if (task) {
    Object.assign(values, {
      task: task.body,
      owned: task.files.join(', '),
      forbidden: [...new Set(others)].join(', ') || 'nothing else named',
      pinned: or(task.pinned, 'none'),
      commit: or(task.commit, `${item}: ${task.title}`),
      focus: or(task.focus, 'none named: judge correctness and the tests'),
      covers: task.covers.filter(n => accepted[n - 1]).map(n => `${n}. ${accepted[n - 1]}`).join('\n') || 'none named in the plan',
    })
  }
  if (kind === 'implementer') Object.assign(values, { carried: or(input.carried, 'none'), rules: rulesGroup(input.rulesMd, 'In every implementer brief') })
  if (kind === 'fix') {
    if (!input.findings?.trim()) throw new Error('a fix brief needs findings')
    Object.assign(values, { round: String(input.round), max: String(c.limits.fixRounds), findings: input.findings.trim() })
  }
  if (kind === 'review') {
    if (!input.commits?.trim()) throw new Error('a review brief needs commits, as <sha>..<sha>')
    const impl = briefPaths(item, 'implementer', input.task, 1, at.briefDir)
    Object.assign(values, { commits: input.commits.trim(), risky: input.risky?.length ? input.risky.join(', ') : 'no risky path; every task is reviewed', brief: impl.brief, implReport: impl.report, findings: or(input.findings, 'the whole task'), rules: rulesGroup(input.rulesMd, 'In every reviewer brief') })
  }
  if (kind === 'final') {
    const acceptance = section(input.specMd, 'Acceptance')
    const by = claims(plan)
    const parkedItems = new Set(parkedAcceptance(plan))
    const coverage = by.size || parkedItems.size ? accepted.map((_, i) => `${i + 1} → ${by.has(i + 1) ? `task${by.get(i + 1)!.length > 1 ? 's' : ''} ${by.get(i + 1)!.join(', ')}` : parkedItems.has(i + 1) ? 'parked' : 'no task'}`).join(' · ') : 'the plan names none'
    // A request with no Acceptance heading (an issue's own text) is judged against the whole of what it says.
    const rulings = (ledger.rulings ?? []).map(r => `${r.n}. ${[r.text, r.why].filter(Boolean).join(' — ')}`).join('\n')
    Object.assign(values, { base: or(ledger.base, c.mainBranch), head: or(input.head, 'HEAD'), acceptance: acceptance || `(The request lists no acceptance criteria: judge the branch against the whole of it.)\n\n${input.specMd.trim()}`, rulings: rulings || 'none', parked: or(plan.parked, 'nothing'), coverage, findings: or(input.findings, 'the whole branch'), rules: rulesGroup(input.rulesMd, 'Before the PR') })
  }
  const { text, missing } = fill(input.template ?? TEMPLATES[kind], values)
  if (missing.length) throw new Error(`the ${kind} template names ${missing.map(x => `{{${x}}}`).join(', ')}, which the tool does not fill`)
  return { text, ...paths, model: m.model, effort: m.effort, role: input.isEscalated && role === 'implementer' ? 'escalate' : role }
}
