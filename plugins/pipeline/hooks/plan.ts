// The plan of an item and the briefs rendered from it. Pure: the caller reads the plan, the spec, the rules and the
// ledger and writes the brief; this parses, checks and fills. The plan format is the one the run skill gives the lead.

import type { Config, Ledger } from '../types'
import { matchesGlob } from './watch'
import { TEMPLATES } from './templates'
import type { BriefKind } from './templates'

export type PlanTask = { n: number; title: string; files: string[]; pinned: string; needs: number[]; check: string; commit: string; focus: string; body: string }
export type Plan = { title: string; constraints: string; parked: string; tasks: PlanTask[] }

const TASK = /^###\s+Task\s+(\d+)\s*[:.—-]?\s*(.*)$/i
const FIELD = /^\s*[-*]\s+\*{0,2}(Files|Pinned|Needs|Check|Commit|Focus)\*{0,2}\s*:\*{0,2}\s*(.*)$/i

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
      current = { n: Number(t[1]), title: (t[2] ?? '').trim(), files: [], pinned: '', needs: [], check: '', commit: '', focus: '', body: '' }
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

/** The numbered lines under a rules.md group heading (`## In every implementer brief`), or `none`. */
export function rulesGroup(rulesMd: string, group: string): string {
  return section(rulesMd, group) || 'none'
}

/** The files of `changed` that match a risky glob, first match per file. */
export function riskyMatches(changed: string[], globs: string[]): string[] {
  return changed.filter(f => globs.some(g => matchesGlob(f, g)))
}

const DIR = 'docs/pipeline/ledgers'

/** The brief and report paths of a dispatch, by the names the ledger folder uses. `round` is the fix round, or the review's (1 is the first). */
export function briefPaths(item: string, kind: BriefKind, task: number, round: number): { brief: string; report: string } {
  const base =
    kind === 'implementer' ? `task-${task}`
    : kind === 'fix' ? `task-${task}-fix-${round}`
    : kind === 'review' ? (round > 1 ? `task-${task}-review-${round}` : `task-${task}-review`)
    : round > 1 ? `final-review-${round}` : 'final'
  return { brief: `${DIR}/${item}/${base}-brief.md`, report: `${DIR}/${item}/${base}-report.md` }
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
}

const or = (s: string | undefined, fallback: string) => (s && s.trim() ? s.trim() : fallback)

/** One brief, filled: its text, its two paths, and the model and effort the config gives the role. Throws with what is missing. */
export function renderBrief(input: BriefInput): { text: string; brief: string; report: string; model: string; effort: string; role: string } {
  const { kind, item, plan, config: c, ledger } = input
  const task = plan.tasks.find(t => t.n === input.task)
  if (kind !== 'final' && !task) throw new Error(`the plan has no task ${input.task}`)
  const paths = briefPaths(item, kind, input.task, input.round)
  const others = plan.tasks.filter(t => t.n !== input.task).flatMap(t => t.files).filter(f => !task?.files.includes(f))
  const role = kind === 'review' ? 'reviewer' : kind === 'final' ? 'final' : 'implementer'
  const m = c.models[input.isEscalated && role === 'implementer' ? 'escalate' : role]
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
    attribution: or(input.attribution ?? (typeof ledger['attribution'] === 'string' ? (ledger['attribution'] as string) : ''), '(no attribution lines)'),
  }
  if (task) {
    Object.assign(values, {
      task: task.body,
      owned: task.files.join(', '),
      forbidden: [...new Set(others)].join(', ') || 'nothing else named',
      pinned: or(task.pinned, 'none'),
      commit: or(task.commit, `${item}: ${task.title}`),
      focus: or(task.focus, 'none named: judge correctness and the tests'),
    })
  }
  if (kind === 'implementer') Object.assign(values, { carried: or(input.carried, 'none'), rules: rulesGroup(input.rulesMd, 'In every implementer brief') })
  if (kind === 'fix') {
    if (!input.findings?.trim()) throw new Error('a fix brief needs findings')
    Object.assign(values, { round: String(input.round), max: String(c.limits.fixRounds), findings: input.findings.trim() })
  }
  if (kind === 'review') {
    if (!input.commits?.trim()) throw new Error('a review brief needs commits, as <sha>..<sha>')
    const impl = briefPaths(item, 'implementer', input.task, 1)
    Object.assign(values, { commits: input.commits.trim(), risky: input.risky?.length ? input.risky.join(', ') : 'no risky path; every task is reviewed', brief: impl.brief, implReport: impl.report, findings: or(input.findings, 'the whole task'), rules: rulesGroup(input.rulesMd, 'In every reviewer brief') })
  }
  if (kind === 'final') {
    const acceptance = section(input.specMd, 'Acceptance')
    if (!acceptance) throw new Error(`docs/pipeline/specs/${item}.md has no Acceptance list`)
    const rulings = (ledger.rulings ?? []).map(r => `${r.n}. ${[r.text, r.why].filter(Boolean).join(' — ')}`).join('\n')
    Object.assign(values, { base: or(ledger.base, c.mainBranch), head: or(input.head, 'HEAD'), acceptance, rulings: rulings || 'none', parked: or(plan.parked, 'nothing'), findings: or(input.findings, 'the whole branch'), rules: rulesGroup(input.rulesMd, 'Before the PR') })
  }
  const { text, missing } = fill(input.template ?? TEMPLATES[kind], values)
  if (missing.length) throw new Error(`the ${kind} template names ${missing.map(x => `{{${x}}}`).join(', ')}, which the tool does not fill`)
  return { text, ...paths, model: m.model, effort: m.effort, role: input.isEscalated && role === 'implementer' ? 'escalate' : role }
}
