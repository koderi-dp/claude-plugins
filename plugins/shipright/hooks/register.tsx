import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Progress } from '../types'
import {
  PHASES,
  activeTask,
  activityFor,
  advance,
  bar,
  classify,
  emptyProgress,
  endStep,
  etaMs,
  formatDuration,
  formatMinutes,
  insideRoot,
  mergeTasks,
  parseLedger,
  parsePlan,
  percent,
  phaseIndex,
  planOf,
  runsGate,
  startStep,
  testCounts,
  type Signal,
} from './progress'

const PANE = 'shipright-progress'
const TITLE = 'Shipright'

const progress = atom({ plugin: 'shipright', key: 'progress' } as const, emptyProgress())
const sessionCwd = atom({ plugin: 'shipright', key: 'cwd' } as const, null)
const paneOpened = atom({ plugin: 'shipright', key: 'paneOpened' } as const, false)

type Api = EngineInterface

async function readText($: Api, path: string): Promise<string> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

async function ledgerDone($: Api, root: string | null): Promise<Set<number>> {
  if (!root) return new Set()
  return parseLedger(await readText($, `${root}/.shipright/ledger.md`))
}

function featureFromSpec(path: string): string | null {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const slug = name.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-design$/, '')
  return slug ? slug.replace(/-/g, ' ') : null
}

async function openPane($: Api) {
  if (await read($, paneOpened)) return
  await update($, paneOpened, () => true)
  void $.ui.open({ id: PANE, title: TITLE })
}

/** State changes that show the moment a call starts: a check, a review or the gate is running. */
function before(p: Progress, sig: Signal, now: number): Progress {
  switch (sig.kind) {
    case 'taskReview':
      // A background reviewer returns at once; its step runs until the session's next step.
      return startStep({ ...p, phase: advance(p.phase, 'build') }, 'review', sig.model ? `review ${sig.model}` : 'review', now)
    case 'check':
      return startStep(p, 'check', 'check', now)
    case 'gate':
      // The gate runs once every task is in. Before that (the planning dry run, a full test run mid-build) it is not the gate.
      if (phaseIndex(p.phase) < phaseIndex('build')) return p
      if (p.tasks.length > 0 && !p.tasks.every(t => t.status === 'done')) return p
      return { ...p, phase: advance(p.phase, 'gate'), gate: 'running', gateStartedAt: now, gateEndedAt: null, gateDetail: null }
    case 'finalReview':
      return { ...p, phase: advance(p.phase, 'review'), reviewModel: sig.model, reviewStartedAt: now, reviewEndedAt: null }
    case 'models':
      return { ...p, phase: advance(p.phase, 'models') }
    case 'pr':
      return { ...p, phase: advance(p.phase, 'pr') }
    default:
      return p
  }
}

/** The final review ends when the session starts acting on it: its first fix, ledger entry, merge or pull request. */
function endReview(p: Progress, now: number): Progress {
  return p.phase === 'review' && p.reviewStartedAt !== null && p.reviewEndedAt === null ? { ...p, reviewEndedAt: now } : p
}

/** State changes once a call has finished, reading the plan or ledger where they changed. */
async function after($: Api, prev: Progress, sig: Signal, ok: boolean, output: string, now: number): Promise<Progress> {
  const p = sig.kind === 'code' || sig.kind === 'ledger' || sig.kind === 'commit' || sig.kind === 'merge' || sig.kind === 'pr'
    ? endReview(prev, now)
    : prev
  const building = phaseIndex(p.phase) >= phaseIndex('build')
  switch (sig.kind) {
    case 'check':
      return endStep(p, 'check', now, ok ? 'pass' : 'fail', testCounts(output))
    case 'spec':
      return {
        ...p,
        root: sig.root,
        feature: p.feature ?? featureFromSpec(sig.path),
        phase: advance(p.phase, 'spec'),
        startedAt: p.startedAt ?? now,
      }
    case 'plan': {
      const plan = parsePlan(await readText($, sig.path))
      const done = await ledgerDone($, sig.root)
      return {
        ...p,
        root: sig.root,
        planPath: sig.path,
        feature: plan.feature ?? p.feature,
        gateCommand: plan.gate ?? p.gateCommand,
        phase: advance(p.phase, 'plan'),
        startedAt: p.startedAt ?? now,
        tasks: mergeTasks(p.tasks, plan.tasks, done, now, building),
      }
    }
    case 'ledger':
    case 'commit': {
      if (!p.planPath || p.tasks.length === 0) return p
      const root = sig.kind === 'ledger' && sig.root ? sig.root : p.root
      const done = await ledgerDone($, root)
      if (done.size === 0 && !building) return p
      const plan = planOf(p.tasks)
      return {
        ...p,
        phase: advance(p.phase, 'build'),
        buildStartedAt: p.buildStartedAt ?? now,
        tasks: mergeTasks(p.tasks, plan, done, now, true),
      }
    }
    case 'code': {
      if (p.tasks.length === 0 || phaseIndex(p.phase) < phaseIndex('plan')) return p
      // Notes, memory files and anything else outside the run's repo are not the build.
      if (!insideRoot(sig.path, p.root)) return p
      if (building) return p.phase === 'build' ? startStep(p, 'code', null, now) : p
      const done = await ledgerDone($, p.root)
      const started = {
        ...p,
        phase: 'build' as const,
        buildStartedAt: p.buildStartedAt ?? now,
        tasks: mergeTasks(p.tasks, planOf(p.tasks), done, now, true),
      }
      return startStep(started, 'code', null, now)
    }
    case 'branch':
      return { ...p, branch: sig.name, phase: p.phase ? advance(p.phase, 'branch') : p.phase }
    case 'gate':
      if (phaseIndex(p.phase) < phaseIndex('gate') || p.gate !== 'running') return p
      return { ...p, gate: ok ? 'pass' : 'fail', gateEndedAt: now, gateDetail: testCounts(output) }
    case 'pr':
      return ok ? { ...p, phase: 'done', finishedBy: 'pr' } : p
    case 'merge':
      // Keeping a repo with no remote local: merging the feature branch into its base ends the run.
      if (!ok || !p.branch || !sig.command.includes(p.branch)) return p
      if (phaseIndex(p.phase) < phaseIndex('review')) return p
      return { ...p, phase: 'done', finishedBy: 'merge' }
    default:
      return p
  }
}

function finish(p: Progress, now: number): Progress {
  return { ...p, activity: activityFor(p), updatedAt: now }
}

/** Picks up an unfinished run from the repo after a restart, so the pane is right from the start. */
async function restore($: Api, cwd: string): Promise<Progress | null> {
  const dir = `${cwd}/.shipright/plans`
  if (!(await $.fs.exists(dir).catch(() => false))) return null
  const plans = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.md'))
  const newest = plans.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  if (!newest) return null
  const planPath = `${dir}/${newest.name}`
  const plan = parsePlan(await readText($, planPath))
  if (plan.tasks.length === 0) return null
  const done = await ledgerDone($, cwd)
  if (plan.tasks.every(t => done.has(t.n))) return null
  const now = await $.clock.now()
  const p: Progress = {
    ...emptyProgress(),
    root: cwd,
    planPath,
    feature: plan.feature,
    gateCommand: plan.gate,
    phase: done.size > 0 ? 'build' : 'plan',
    startedAt: now,
    buildStartedAt: done.size > 0 ? now : null,
    tasks: mergeTasks([], plan.tasks, done, now, done.size > 0),
  }
  return finish(p, now)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'shipright-progress',
      description: 'Show the live progress of the current shipright run',
    })
    await update($, sessionCwd, () => e.cwd)
    const current = await read($, progress)
    if (current.phase === null) {
      const restored = await restore($, e.cwd).catch(() => null)
      if (restored) {
        await update($, progress, () => restored)
        await openPane($)
      }
    }
    return next(e)
  })

  on('command.run', { command: 'shipright-progress' }, async $ => {
    await update($, paneOpened, () => true)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Shipright progress pane opened.' }
  })

  on('tool.call', async ($, e, next) => {
    let sig: Signal | null = null
    try {
      sig = classify(e as unknown as { tool: string; [key: string]: unknown })
    } catch {
      sig = null
    }
    try {
      const input = e as unknown as { tool: string; command?: unknown }
      if ((input.tool === 'Bash' || input.tool === 'PowerShell') && (!sig || sig.kind === 'gate')) {
        const command = String(input.command ?? '')
        const current = await read($, progress)
        const task = activeTask(current)
        // The active task's own Done check comes first: the last task's check is often the gate command itself.
        if (task && runsGate(command, task.check)) sig = { kind: 'check', command: task.check ?? command }
        else if (!sig && runsGate(command, current.gateCommand)) sig = { kind: 'gate' }
      }
    } catch {
      /* fall back to what classify found */
    }
    if (!sig) return next(e)
    const signal = sig

    try {
      const now = await $.clock.now()
      await update($, progress, p => finish(before(p, signal, now), now))
    } catch {
      /* progress is a view; never let it break a tool call */
    }

    const ran = await next(e)

    try {
      const ok = ran.deny === undefined && ran.isError !== true
      const output = typeof ran.text === 'string' ? ran.text : ''
      const now = await $.clock.now()
      const current = await read($, progress)
      if (current.phase === null && signal.kind === 'ledger' && signal.root) {
        // The plugin loaded mid-run, or the run lives outside the session's folder: pick it up from its ledger.
        const restored = await restore($, signal.root).catch(() => null)
        if (restored) {
          await update($, progress, () => restored)
          await openPane($)
        }
        return ran
      }
      if (current.phase === null && signal.kind !== 'spec' && signal.kind !== 'plan') return ran
      const updated = finish(await after($, current, signal, ok, output, now), now)
      await update($, progress, () => updated)
      if (updated.phase !== null) await openPane($)
    } catch {
      /* progress is a view; never let it break a tool call */
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const p = await read($, progress)
    const now = await $.clock.now()
    const cols = Math.max(24, e.props.bodyColumns)
    const rows = e.viewport?.rows ?? 40

    if (p.phase === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>No shipright run in this session yet.</Text>
          <Text dimColor>Start one with /shipright. This pane follows it by itself.</Text>
        </Box>
      )
    }

    const pct = percent(p)
    const done = p.tasks.filter(t => t.status === 'done').length
    const eta = etaMs(p, now)
    const timing = [
      p.startedAt !== null ? `${formatMinutes(now - p.startedAt)} elapsed` : null,
      eta !== null ? `about ${formatMinutes(eta)} of building left` : null,
    ]
      .filter(Boolean)
      .join(', ')
    const at = phaseIndex(p.phase)

    const activeIdx = p.tasks.findIndex(t => t.status === 'active' || t.status === 'review')
    const activeSteps = activeIdx < 0 ? 0 : (p.tasks[activeIdx]?.steps.length ?? 0)
    const room = Math.max(3, rows - 20 - activeSteps)
    const start = p.tasks.length <= room ? 0 : Math.max(0, Math.min(p.tasks.length - room, (activeIdx < 0 ? done : activeIdx) - 2))
    const shown = p.tasks.slice(start, start + room)
    const clip = (s: string, width = cols - 2) => (s.length > width ? `${s.slice(0, Math.max(1, width - 1))}…` : s)
    const span = (from: number | null, to: number | null) => (from === null ? '' : formatDuration((to ?? now) - from))

    /** A line with its text on the left and a dim duration or count on the right; the left side gives way first. */
    const row = (left: string, right: string, color?: string, dim?: boolean, key?: string) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" gap={1}>
        <Text color={color} dimColor={dim}>{clip(left, cols - 3 - right.length)}</Text>
        {right ? <Text dimColor>{right}</Text> : null}
      </Box>
    )

    const phaseRight = (id: string) => {
      if (id === 'gate' && p.gateStartedAt !== null) return [span(p.gateStartedAt, p.gateEndedAt), p.gateDetail].filter(Boolean).join('  ')
      if (id === 'review' && p.reviewStartedAt !== null) return [p.reviewModel, span(p.reviewStartedAt, p.reviewEndedAt)].filter(Boolean).join('  ')
      return ''
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text weight="semibold">{clip(p.feature ?? 'Shipright run')}</Text>
          {p.branch ? <Text dimColor>{clip(p.branch)}</Text> : null}
        </Box>
        <Box flexDirection="column">
          <Text mono color={p.phase === 'done' ? 'success' : 'claude'}>{`${bar(pct, Math.min(40, cols - 6))} ${pct}%`}</Text>
          <Text color={p.gate === 'fail' && p.phase === 'gate' ? 'error' : undefined}>{clip(p.activity)}</Text>
          {timing ? <Text dimColor>{clip(timing)}</Text> : null}
        </Box>
        <Box flexDirection="column">
          {PHASES.map((ph, i) => {
            const isDone = i < at || p.phase === 'done'
            const isNow = i === at && p.phase !== 'done'
            const note = ph.id === 'build' && p.tasks.length > 0 ? `  ${done}/${p.tasks.length}` : ''
            const failed = ph.id === 'gate' && p.gate === 'fail'
            return row(
              `${isDone ? '✓' : isNow ? '▶' : '○'} ${ph.label}${note}`,
              phaseRight(ph.id),
              failed && isNow ? 'error' : isDone ? 'success' : isNow ? 'claude' : undefined,
              !isDone && !isNow,
              ph.id,
            )
          })}
        </Box>
        {p.tasks.length > 0 ? (
          <Box flexDirection="column">
            <Text weight="semibold">{`Tasks ${done}/${p.tasks.length}`}</Text>
            {start > 0 ? <Text dimColor>{`  ${start} earlier done`}</Text> : null}
            {shown.map(t => {
              const working = t.status === 'active' || t.status === 'review'
              const line = row(
                `${t.status === 'done' ? '✓' : t.status === 'review' ? '◆' : working ? '▶' : '○'} ${t.n}. ${t.title}${t.status === 'review' ? ' (review)' : ''}`,
                t.status === 'pending' ? '' : span(t.startedAt, t.doneAt),
                t.status === 'done' ? 'success' : t.status === 'pending' ? undefined : 'claude',
                t.status === 'pending',
                `task-${t.n}`,
              )
              if (!working || t.steps.length === 0) return line
              return (
                <Box key={`task-${t.n}-group`} flexDirection="column">
                  {line}
                  {t.steps.map((s, i) => {
                    const mark = s.endedAt === null ? '▶' : s.result === 'fail' ? '✗' : '✓'
                    const right = [s.endedAt === null ? null : s.detail, span(s.startedAt, s.endedAt)].filter(Boolean).join('  ')
                    const color = s.endedAt === null ? 'claude' : s.result === 'fail' ? 'error' : undefined
                    return row(`    ${mark} ${s.label}`, right, color, s.endedAt !== null && s.result !== 'fail', `step-${t.n}-${i}`)
                  })}
                </Box>
              )
            })}
            {start + room < p.tasks.length ? <Text dimColor>{`  ${p.tasks.length - start - room} more`}</Text> : null}
          </Box>
        ) : null}
      </Box>
    )
  })
}
