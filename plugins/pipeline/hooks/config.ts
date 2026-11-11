// The config: defaults, validation and the draft made from what a project shows. Pure.

import type { Config, ModelSpec, Role, Runner } from '../types'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'default'] as const
const ROLES: Role[] = ['implementer', 'reviewer', 'final', 'escalate']

export const DEFAULTS: Config = {
  version: 1,
  mainBranch: 'main',
  branch: 'feat/<id>',
  checks: {},
  riskyPaths: [],
  protectedPaths: ['.github/workflows/**'],
  models: {
    implementer: { model: 'sonnet', effort: 'medium' },
    reviewer: { model: 'opus', effort: 'high' },
    final: { model: 'opus', effort: 'xhigh' },
    escalate: { model: 'opus', effort: 'high' },
  },
  limits: { fixRounds: 3, silentMinutes: 10, taskMinutes: 45, itemTokens: 4000000, parallel: 1 },
  runner: 'subagent',
  merge: 'pr',
  mergeMethod: 'merge',
  retain: { plans: true, briefs: false, superpowers: false },
  stop: [
    'product decision the spec leaves open',
    'security trade-off',
    'CI that cannot be made green',
    'credentials or external services',
    'new cost',
    'destructive data change',
  ],
  afterMerge: ['docs/pipeline/BACKLOG.md'],
  notify: 'milestones',
  renameSession: true,
  pushMain: true,
  taskReview: 'risky',
  superpowers: 'off',
  queue: 'file',
  queueLabel: 'pipeline',
}

const kind = (x: unknown) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x)
const isRecord = (x: unknown): x is Record<string, unknown> => kind(x) === 'object'
const quote = (xs: readonly string[], last = 'or') => xs.map(x => `"${x}"`).reduce((a, b, i) => `${a}${i === xs.length - 1 ? ` ${last} ` : ', '}${b}`)

/** Fills missing keys from the defaults and names every wrong type; unknown keys survive. */
export function normalizeConfig(raw: unknown): { config: Config; problems: string[] } {
  if (!isRecord(raw)) return { config: structuredClone(DEFAULTS), problems: [`config: expected an object, got ${kind(raw)}`] }
  const problems: string[] = []
  const str = (key: string, fallback: string): string => {
    const v = raw[key]
    if (v === undefined) return fallback
    if (typeof v === 'string') return v
    problems.push(`${key}: expected a string, got ${kind(v)}`)
    return fallback
  }
  const strings = (key: string, fallback: string[]): string[] => {
    const v = raw[key]
    if (v === undefined) return [...fallback]
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return [...(v as string[])]
    problems.push(`${key}: expected an array of strings, got ${kind(v)}`)
    return [...fallback]
  }
  const bool = (key: string, fallback: boolean): boolean => {
    const v = raw[key]
    if (v === undefined) return fallback
    if (typeof v === 'boolean') return v
    problems.push(`${key}: expected a boolean, got ${kind(v)}`)
    return fallback
  }
  const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = raw[key]
    if (v === undefined) return fallback
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T
    problems.push(`${key}: expected ${quote(allowed)}, got ${JSON.stringify(v)}`)
    return fallback
  }

  const checks: Config['checks'] = {}
  const rawChecks = raw['checks']
  if (rawChecks !== undefined) {
    if (!isRecord(rawChecks)) problems.push(`checks: expected an object, got ${kind(rawChecks)}`)
    else
      for (const tier of ['fast', 'task', 'gate'] as const) {
        const v = rawChecks[tier]
        if (v === undefined) continue
        if (typeof v === 'string') checks[tier] = v
        else problems.push(`checks.${tier}: expected a string, got ${kind(v)}`)
      }
  }

  const limits = { ...DEFAULTS.limits }
  const rawLimits = raw['limits']
  if (rawLimits !== undefined) {
    if (!isRecord(rawLimits)) problems.push(`limits: expected an object, got ${kind(rawLimits)}`)
    else
      for (const key of Object.keys(limits) as (keyof Config['limits'])[]) {
        const v = rawLimits[key]
        if (v === undefined) continue
        if (typeof v === 'number' && Number.isFinite(v)) limits[key] = v
        else problems.push(`limits.${key}: expected a number, got ${kind(v)}`)
      }
  }

  const models = structuredClone(DEFAULTS.models)
  const rawModels = raw['models']
  if (rawModels !== undefined) {
    if (!isRecord(rawModels)) problems.push(`models: expected an object, got ${kind(rawModels)}`)
    else
      for (const role of ROLES) {
        const v = rawModels[role]
        if (v === undefined) continue
        if (!isRecord(v)) {
          problems.push(`models.${role}: expected an object, got ${kind(v)}`)
          continue
        }
        const spec: ModelSpec = { ...models[role] }
        if (v['model'] !== undefined) {
          if (typeof v['model'] === 'string') spec.model = v['model']
          else problems.push(`models.${role}.model: expected a string, got ${kind(v['model'])}`)
        }
        if (v['effort'] !== undefined) {
          if (typeof v['effort'] === 'string' && (EFFORTS as readonly string[]).includes(v['effort'])) spec.effort = v['effort'] as ModelSpec['effort']
          else problems.push(`models.${role}.effort: expected one of ${EFFORTS.join(', ')}, got ${JSON.stringify(v['effort'])}`)
        }
        models[role] = spec
      }
  }

  const known = new Set(['version', 'mainBranch', 'branch', 'checks', 'riskyPaths', 'protectedPaths', 'models', 'limits', 'runner', 'merge', 'mergeMethod', 'stop', 'afterMerge', 'retain', 'notify', 'renameSession', 'taskReview', 'superpowers', 'pushMain', 'queue', 'queueLabel'])
  const extra = Object.fromEntries(Object.entries(raw).filter(([k]) => !known.has(k)))
  const config: Config = {
    ...extra,
    version: 1,
    mainBranch: str('mainBranch', DEFAULTS.mainBranch),
    branch: str('branch', DEFAULTS.branch),
    checks,
    riskyPaths: strings('riskyPaths', DEFAULTS.riskyPaths),
    protectedPaths: strings('protectedPaths', DEFAULTS.protectedPaths),
    models,
    limits,
    runner: oneOf<Runner>('runner', ['subagent', 'session'] as const, DEFAULTS.runner),
    merge: oneOf('merge', ['auto', 'pr'] as const, DEFAULTS.merge),
    mergeMethod: oneOf('mergeMethod', ['merge', 'squash'] as const, DEFAULTS.mergeMethod),
    stop: strings('stop', DEFAULTS.stop),
    afterMerge: strings('afterMerge', DEFAULTS.afterMerge),
    retain: retainOf(raw['retain'], problems),
    notify: oneOf('notify', ['off', 'milestones', 'all'] as const, DEFAULTS.notify),
    renameSession: bool('renameSession', DEFAULTS.renameSession),
    pushMain: bool('pushMain', DEFAULTS.pushMain),
    taskReview: oneOf('taskReview', ['risky', 'always', 'off'] as const, DEFAULTS.taskReview),
    superpowers: oneOf('superpowers', ['off', 'on'] as const, DEFAULTS.superpowers),
    queue: queueOf(raw['queue'], problems),
    queueLabel: queueLabelOf(raw['queueLabel'], problems),
  }
  return { config, problems }
}

/** The queue mode: "file" or "github"; anything else is named and the default used. */
function queueOf(raw: unknown, problems: string[]): Config['queue'] {
  if (raw === undefined) return DEFAULTS.queue
  if (raw === 'file' || raw === 'github') return raw
  problems.push('queue must be "file" or "github"')
  return DEFAULTS.queue
}

/** The queue label: a non-empty label name without a comma, since gh takes labels as a comma list; anything else is named and the default used. */
function queueLabelOf(raw: unknown, problems: string[]): string {
  if (raw === undefined) return DEFAULTS.queueLabel
  if (typeof raw === 'string' && raw.trim() !== '' && !raw.includes(',')) return raw
  problems.push('queueLabel must be a label name without a comma')
  return DEFAULTS.queueLabel
}

/** The retain block: each flag a boolean, missing ones from the defaults, wrong types named. */
function retainOf(raw: unknown, problems: string[]): Config['retain'] {
  const out = { ...DEFAULTS.retain }
  if (raw === undefined) return out
  if (!isRecord(raw)) {
    problems.push(`retain: expected an object, got ${kind(raw)}`)
    return out
  }
  for (const key of ['plans', 'briefs', 'superpowers'] as const) {
    const v = raw[key]
    if (v === undefined) continue
    if (typeof v === 'boolean') out[key] = v
    else problems.push(`retain.${key}: expected a boolean, got ${kind(v)}`)
  }
  return out
}

/** What the project shows: package scripts, make targets, the CI text, its top-level directory names and the prose files. */
export type Found = { scripts: Record<string, string>; makeTargets: string[]; ci: string; dirs: string[]; prose: string[] }

const RISKY = /\b(auth|session|migration|parser|concurrency|lock|payment|price|pricing|money|crypto|token)s?\b/i
const GATE_NAMES = ['check', 'verify', 'gate', 'ci']
const COMBO = ['build', 'typecheck', 'test', 'lint', 'format:check']
const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const NONE = 'none found; fill in'

/** Sentences, with hard-wrapped lines of a paragraph joined first. */
const sentences = (prose: string[]) => prose.flatMap(p => p.split(/\n\s*\n/)).flatMap(p => p.replace(/\s*\n\s*/g, ' ').split(/(?<=[.!?])\s+/)).map(s => s.trim()).filter(Boolean)

/** The directories a sentence names: tokens with a slash whose first segment is a top-level directory of the project, as `dir/**` globs; a trailing file glob is dropped, a file name skips the token. */
function dirsIn(sentence: string, dirs: string[]): string[] {
  const out: string[] = []
  for (const raw of sentence.split(/[\s,;:()`'"]+/)) {
    const t = raw.replace(/[.!?]+$/, '')
    if (!t.includes('/') || /^https?:/.test(t) || t.startsWith('/')) continue
    const segments = t.replace(/\/\*\*$/, '').replace(/\/$/, '').split('/')
    if (segments.at(-1)?.includes('*')) segments.pop()
    if (segments.length === 0 || !dirs.includes(segments[0] ?? '')) continue
    if (/\.[a-z]+$/i.test(segments.at(-1) ?? '')) continue
    out.push(`${segments.join('/')}/**`)
  }
  return out
}

const BROAD = 'broad: narrow to the auth, migration, payment or parser folders'

/** A risky path that would send most diffs to review: a whole top-level directory (`packages/**`) or a whole `src` tree (`apps/web/src/**`). */
function isBroad(glob: string): boolean {
  const segments = glob.replace(/\/\*\*$/, '').split('/')
  return segments.length === 1 || segments.at(-1) === 'src'
}

/** The stop conditions a sentence lists after "ask the user only for", "stop and ask" or "ask only when", or the action of "do not ... without asking". */
function stopsIn(sentence: string): string[] {
  const asking = /\bdo not\s+(.+?)\s+without asking\b/i.exec(sentence)
  if (asking?.[1]) return [asking[1].trim()]
  const m = /(?:ask the user only for|stop and ask|ask only when|ask only for)\s*(?:when\s+|for\s+)?(.*)$/i.exec(sentence)
  if (!m?.[1]) return []
  return m[1]
    .replace(/[.!?]+$/, '')
    .split(/[;,]/)
    .map(s => s.trim().replace(/^(?:or|and)\s+/i, '').replace(/^(?:when|for)\s+/i, '').trim())
    .filter(Boolean)
}

/** A config drafted from scripts, make targets, CI and prose, with the source of every key. */
export function draftConfig(found: Found): { config: Config; sources: Record<string, string> } {
  const config = structuredClone(DEFAULTS)
  const sources: Record<string, string> = {}
  const scripts = found.scripts
  const make = found.makeTargets
  const npm = (name: string) => `npm run ${name}`

  for (const key of ['mainBranch', 'branch', 'protectedPaths', 'models', 'limits.silentMinutes', 'limits.taskMinutes', 'limits.itemTokens', 'limits.parallel', 'runner', 'afterMerge', 'retain', 'notify', 'renameSession', 'taskReview', 'superpowers', 'pushMain']) sources[key] = 'default'

  const fast = ['check:fast', 'lint:fast'].find(n => n in scripts)
  if (fast) {
    config.checks.fast = npm(fast)
    sources['checks.fast'] = `package script ${fast}`
  } else sources['checks.fast'] = NONE

  const task = ['test', 'test:unit'].find(n => n in scripts)
  if (task) {
    config.checks.task = npm(task)
    sources['checks.task'] = `package script ${task}`
  } else if (make.includes('test')) {
    config.checks.task = 'make test'
    sources['checks.task'] = 'make target test'
  } else sources['checks.task'] = NONE

  const gateScript = GATE_NAMES.find(n => n in scripts)
  const gateMake = GATE_NAMES.find(n => make.includes(n))
  const comboScripts = COMBO.filter(n => n in scripts)
  const comboMake = COMBO.filter(n => make.includes(n))
  if (gateScript) {
    config.checks.gate = npm(gateScript)
    sources['checks.gate'] = `package script ${gateScript}`
  } else if (gateMake) {
    config.checks.gate = `make ${gateMake}`
    sources['checks.gate'] = `make target ${gateMake}`
  } else if (comboScripts.length) {
    config.checks.gate = comboScripts.map(npm).join(' && ')
    sources['checks.gate'] = `package scripts ${comboScripts.join(', ')}`
  } else if (comboMake.length) {
    config.checks.gate = comboMake.map(n => `make ${n}`).join(' && ')
    sources['checks.gate'] = `make targets ${comboMake.join(', ')}`
  } else sources['checks.gate'] = NONE

  const lines = sentences(found.prose)
  const risky = [...new Set(lines.filter(s => RISKY.test(s)).flatMap(s => dirsIn(s, found.dirs)))]
  config.riskyPaths = risky
  const broad = risky.filter(isBroad)
  const warning = broad.length ? `; ${broad.join(', ')} ${broad.length === 1 ? 'is' : 'are'} ${BROAD}` : ''
  sources['riskyPaths'] = risky.length ? `prose naming risky code (${risky.length} director${risky.length === 1 ? 'y' : 'ies'})${warning}` : NONE

  const stops = [...new Set(lines.flatMap(stopsIn))]
  if (stops.length) {
    config.stop = stops
    sources['stop'] = 'prose: the "ask only for" list'
  } else sources['stop'] = 'default'

  // The first sentence that puts a number before "fix rounds" or "failed reviews"; "each fix round" names none.
  const rounds = lines
    .map(s => /\b(\w+)\s+(?:fix[- ]rounds?|failed reviews)\b/i.exec(s))
    .map(m => (m ? { text: m[0], n: NUMBERS[(m[1] ?? '').toLowerCase()] ?? Number(m[1]) } : null))
    .find(m => m !== null && Number.isInteger(m.n) && m.n > 0)
  if (rounds) {
    config.limits.fixRounds = rounds.n
    sources['limits.fixRounds'] = `prose: "${rounds.text}"`
  } else sources['limits.fixRounds'] = 'default'

  const auto = lines.find(s => /\bauto[- ]merge/i.test(s))
  if (auto) {
    config.merge = 'auto'
    sources['merge'] = 'prose: auto-merge'
  } else sources['merge'] = 'default'
  sources['mergeMethod'] = 'default'

  return { config, sources }
}
