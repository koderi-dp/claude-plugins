import type { Phase, Progress, Step, StepKind, Task } from '../types'

export const PHASES: readonly { id: Phase; label: string; weight: number }[] = [
  { id: 'spec', label: 'Spec', weight: 5 },
  { id: 'plan', label: 'Plan', weight: 10 },
  { id: 'models', label: 'Models', weight: 2 },
  { id: 'branch', label: 'Branch', weight: 3 },
  { id: 'build', label: 'Build', weight: 60 },
  { id: 'gate', label: 'Release gate', weight: 8 },
  { id: 'review', label: 'Final review', weight: 7 },
  { id: 'pr', label: 'Pull request', weight: 5 },
]

export function emptyProgress(): Progress {
  return {
    root: null,
    planPath: null,
    feature: null,
    branch: null,
    phase: null,
    tasks: [],
    startedAt: null,
    buildStartedAt: null,
    gate: null,
    gateCommand: null,
    gateStartedAt: null,
    gateEndedAt: null,
    gateDetail: null,
    reviewModel: null,
    reviewStartedAt: null,
    reviewEndedAt: null,
    finishedBy: null,
    activity: '',
    updatedAt: 0,
  }
}

export function phaseIndex(phase: Phase | null): number {
  if (phase === null) return -1
  if (phase === 'done') return PHASES.length
  return PHASES.findIndex(p => p.id === phase)
}

/** Phases only move forward; a late event from an earlier phase never rewinds the view. */
export function advance(current: Phase | null, next: Phase): Phase {
  return phaseIndex(next) >= phaseIndex(current) ? next : (current as Phase)
}

const TASK_HEADING = /^#{2,3}\s+Task\s+(\d+)\s*[:.\-–]?\s*(.*)$/gm

export type PlanTask = { n: number; title: string; check: string | null }

/** Tasks (with each one's `Done:` check), feature name and gate command from a shipright plan (also reads older `### Task N:` plans). */
export function parsePlan(text: string): { feature: string | null; gate: string | null; tasks: PlanTask[] } {
  const title = /^#\s+(.+?)\s*$/m.exec(text)?.[1] ?? null
  const feature = title ? title.replace(/\s+(implementation\s+)?plan$/i, '').trim() || null : null
  const gate = /^Gate:\s*`([^`]+)`/m.exec(text)?.[1]?.trim() || null
  const headings = [...text.matchAll(TASK_HEADING)]
  const seen = new Set<number>()
  const tasks: PlanTask[] = []
  headings.forEach((m, i) => {
    const n = Number(m[1])
    if (seen.has(n)) return
    seen.add(n)
    const block = text.slice(m.index ?? 0, headings[i + 1]?.index ?? text.length)
    const check = /^Done:\s*`([^`]+)`/m.exec(block)?.[1]?.trim() || null
    tasks.push({ n, title: (m[2] ?? '').trim() || `Task ${n}`, check })
  })
  return { feature, gate, tasks }
}

/** Whether a shell command runs the plan's gate: one of its `&&`, `;` or `|` parts is exactly that command. */
export function runsGate(command: string, gate: string | null): boolean {
  if (!gate) return false
  const want = gate.replace(/\s+/g, ' ').trim()
  return command.split(/&&|\|\||;|\|/).some(part => part.replace(/\s+/g, ' ').trim() === want)
}

/** Whether a written file belongs to the run's repo (case-insensitive, as on Windows). */
export function insideRoot(path: string, root: string | null): boolean {
  if (!root) return false
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(path).startsWith(`${norm(root)}/`)
}

/** Task numbers the ledger records as committed. */
export function parseLedger(text: string): Set<number> {
  const done = new Set<number>()
  for (const m of text.matchAll(/^##\s+Task\s+(\d+)/gm)) done.add(Number(m[1]))
  return done
}

/**
 * Rebuilds the task list from the plan and the ledger, keeping when each task finished.
 * With `building`, the first unfinished task is the active one.
 */
export function mergeTasks(previous: Task[], plan: PlanTask[], done: Set<number>, now: number, building: boolean): Task[] {
  const before = new Map(previous.map(t => [t.n, t]))
  let activeSet = false
  return plan.map(({ n, title, check }) => {
    const old = before.get(n)
    const base = { n, title, check }
    if (done.has(n)) {
      // A finished task shows as one line: its steps go, its total stays.
      return { ...base, status: 'done', startedAt: old?.startedAt ?? null, doneAt: old?.doneAt ?? now, steps: [] }
    }
    if (building && !activeSet) {
      activeSet = true
      return {
        ...base,
        status: old?.status === 'review' ? 'review' : 'active',
        startedAt: old?.startedAt ?? now,
        doneAt: null,
        steps: old?.steps ?? [],
      }
    }
    return { ...base, status: 'pending', startedAt: null, doneAt: null, steps: [] }
  })
}

/** The plan's tasks as `mergeTasks` takes them, from the pane's current list. */
export function planOf(tasks: Task[]): PlanTask[] {
  return tasks.map(({ n, title, check }) => ({ n, title, check }))
}

function closeSteps(steps: Step[], now: number): Step[] {
  return steps.map(s => (s.endedAt === null ? { ...s, endedAt: now } : s))
}

export function activeTask(p: Progress): Task | undefined {
  return p.tasks.find(t => t.status === 'active' || t.status === 'review')
}

/**
 * Starts a step on the active task, ending the one that was running. Writing more code while code is
 * already being written is the same step; code written after a check or a review is a fix.
 */
export function startStep(p: Progress, kind: StepKind, label: string | null, now: number): Progress {
  const task = activeTask(p)
  if (!task) return p
  const last = task.steps[task.steps.length - 1]
  if (kind === 'code' && last?.kind === 'code' && last.endedAt === null) return p
  const name = label ?? (kind === 'code' ? (task.steps.length === 0 ? 'code and tests' : 'fix') : kind)
  const step: Step = { kind, label: name, startedAt: now, endedAt: null, result: null, detail: null }
  const status = kind === 'review' ? 'review' : 'active'
  return {
    ...p,
    tasks: p.tasks.map(t => (t === task ? { ...t, status, steps: [...closeSteps(t.steps, now), step] } : t)),
  }
}

/** Ends the active task's running step of this kind, with its result. */
export function endStep(p: Progress, kind: StepKind, now: number, result: 'pass' | 'fail' | null, detail: string | null): Progress {
  const task = activeTask(p)
  if (!task) return p
  const at = task.steps.map(s => s.kind === kind && s.endedAt === null).lastIndexOf(true)
  if (at < 0) return p
  const steps = task.steps.map((s, i) => (i === at ? { ...s, endedAt: now, result, detail } : s))
  return { ...p, tasks: p.tasks.map(t => (t === task ? { ...t, steps } : t)) }
}

/** `passed/total` from a test runner's output (node --test, bun test, jest/vitest), or null when not recognised. */
export function testCounts(output: string): string | null {
  const nodeTests = /^\D{0,3}tests\s+(\d+)\s*$/m.exec(output)
  const nodePass = /^\D{0,3}pass\s+(\d+)\s*$/m.exec(output)
  if (nodeTests && nodePass) return `${nodePass[1]}/${nodeTests[1]}`
  const bunPass = /^\s*(\d+)\s+pass\s*$/m.exec(output)
  const bunFail = /^\s*(\d+)\s+fail\s*$/m.exec(output)
  if (bunPass && bunFail) return `${bunPass[1]}/${Number(bunPass[1]) + Number(bunFail[1])}`
  const jest = /Tests:\s+(?:\d+\s+failed,\s+)?(?:\d+\s+skipped,\s+)?(\d+)\s+passed,\s+(\d+)\s+total/.exec(output)
  if (jest) return `${jest[1]}/${jest[2]}`
  return null
}

/** A short duration: `45s`, `4m 12s`, `1h 05m`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function percent(p: Progress): number {
  if (p.phase === 'done') return 100
  const at = phaseIndex(p.phase)
  if (at < 0) return 0
  let total = 0
  for (let i = 0; i < at; i++) total += PHASES[i]?.weight ?? 0
  const current = PHASES[at]
  if (!current) return 0
  let fraction = 0.5
  if (current.id === 'build' && p.tasks.length > 0) {
    const done = p.tasks.filter(t => t.status === 'done').length
    const working = p.tasks.some(t => t.status === 'active' || t.status === 'review') ? 0.5 : 0
    fraction = (done + working) / p.tasks.length
  }
  if (current.id === 'gate' && p.gate === 'pass') fraction = 1
  return Math.min(99, Math.round(total + current.weight * fraction))
}

/** Remaining build time from the average finished task, or null before the first one. */
export function etaMs(p: Progress, now: number): number | null {
  if (p.phase !== 'build' || p.buildStartedAt === null) return null
  const finished = p.tasks.filter(t => t.status === 'done' && t.doneAt !== null)
  if (finished.length === 0) return null
  const last = Math.max(...finished.map(t => t.doneAt as number))
  const avg = (last - p.buildStartedAt) / finished.length
  const left = p.tasks.length - finished.length
  return Math.max(0, avg * left - Math.max(0, now - last))
}

export function formatMinutes(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'under a minute'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} h ${min % 60} min`
}

export function bar(pct: number, width: number): string {
  const w = Math.max(10, width)
  const filled = Math.round((pct / 100) * w)
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

export type Signal =
  | { kind: 'spec'; root: string; path: string }
  | { kind: 'plan'; root: string; path: string }
  | { kind: 'ledger'; root: string | null }
  | { kind: 'code'; path: string }
  | { kind: 'branch'; name: string }
  | { kind: 'commit' }
  | { kind: 'gate' }
  | { kind: 'push' }
  | { kind: 'pr' }
  | { kind: 'merge'; command: string }
  | { kind: 'models' }
  | { kind: 'check'; command: string }
  | { kind: 'taskReview'; model: string | null }
  | { kind: 'finalReview'; model: string | null }

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

function shiprightPath(raw: string): { root: string; rest: string } | null {
  const path = raw.replace(/\\/g, '/')
  const at = path.indexOf('/.shipright/')
  if (at < 0) return null
  return { root: path.slice(0, at), rest: path.slice(at + '/.shipright/'.length) }
}

/** What a tool call means for the run, read from its input alone. */
export function classify(input: { tool: string; [key: string]: unknown }): Signal | null {
  const { tool } = input
  if (EDIT_TOOLS.has(tool)) {
    const raw = String(input.file_path ?? input.notebook_path ?? '')
    if (!raw) return null
    const sr = shiprightPath(raw)
    if (sr?.rest.startsWith('specs/')) return { kind: 'spec', root: sr.root, path: raw }
    if (sr?.rest.startsWith('plans/')) return { kind: 'plan', root: sr.root, path: raw }
    if (sr?.rest === 'ledger.md') return { kind: 'ledger', root: sr.root }
    if (sr) return null
    return { kind: 'code', path: raw }
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(input.command ?? '')
    if (/gh\s+pr\s+create/.test(cmd)) return { kind: 'pr' }
    if (/check:release|release[-_ ]gate/.test(cmd)) return { kind: 'gate' }
    const branch = /git\s+(?:switch\s+-c|checkout\s+-b)\s+(\S+)/.exec(cmd)
    if (branch?.[1]) return { kind: 'branch', name: branch[1] }
    if (/\.shipright[\\/]ledger\.md/.test(cmd)) return { kind: 'ledger', root: null }
    if (/git\s+commit\b/.test(cmd)) return { kind: 'commit' }
    if (/git\s+push\b/.test(cmd)) return { kind: 'push' }
    if (/git\s+merge\b/.test(cmd)) return { kind: 'merge', command: cmd }
    return null
  }
  if (tool === 'Agent' || tool === 'Task') {
    const type = String(input.subagent_type ?? '')
    const model = [input.model, input.effort].filter(v => typeof v === 'string' && v).join(' ') || null
    if (type.endsWith('task-reviewer')) return { kind: 'taskReview', model }
    if (type.endsWith('final-reviewer')) return { kind: 'finalReview', model }
    return null
  }
  if (tool === 'AskUserQuestion') {
    const questions = Array.isArray(input.questions) ? input.questions : []
    const asked = questions.map(q => String((q as { question?: unknown })?.question ?? '')).join(' ')
    return /final review|task review/i.test(asked) ? { kind: 'models' } : null
  }
  return null
}

/** The short activity line for the pane. */
export function activityFor(p: Progress): string {
  const active = p.tasks.find(t => t.status === 'active' || t.status === 'review')
  const done = p.tasks.filter(t => t.status === 'done').length
  switch (p.phase) {
    case 'spec':
      return 'Writing the spec'
    case 'plan':
      return p.tasks.length ? `Plan ready, ${p.tasks.length} task${p.tasks.length === 1 ? '' : 's'}` : 'Writing the plan'
    case 'models':
      return 'Waiting for your model choices'
    case 'branch':
      return `On ${p.branch ?? 'the feature branch'}`
    case 'build':
      if (!active) return `${done} of ${p.tasks.length} tasks done`
      if (active.status === 'review') return `Task ${active.n} of ${p.tasks.length}: in review`
      return `Task ${active.n} of ${p.tasks.length}: ${active.steps.some(s => s.kind === 'check' && s.endedAt === null) ? 'running its check' : 'building'}`
    case 'gate':
      return p.gate === 'fail' ? 'Release gate failed, fixing' : p.gate === 'pass' ? 'Release gate passed' : 'Running the release gate'
    case 'review':
      return 'Final review of the whole branch'
    case 'pr':
      return 'Opening the pull request'
    case 'done':
      return p.finishedBy === 'merge' ? 'Merged locally' : 'Pull request opened'
    default:
      return ''
  }
}
