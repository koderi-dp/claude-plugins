// The config: defaults, validation and the draft made from what a project shows. Pure.

import type { Config, ModelSpec, Role } from '../types'

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
  limits: { fixRounds: 3, silentMinutes: 10, taskMinutes: 45, itemTokens: 4000000 },
  merge: 'pr',
  mergeMethod: 'merge',
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

  const known = new Set(['version', 'mainBranch', 'branch', 'checks', 'riskyPaths', 'protectedPaths', 'models', 'limits', 'merge', 'mergeMethod', 'stop', 'afterMerge', 'notify'])
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
    merge: oneOf('merge', ['auto', 'pr'] as const, DEFAULTS.merge),
    mergeMethod: oneOf('mergeMethod', ['merge', 'squash'] as const, DEFAULTS.mergeMethod),
    stop: strings('stop', DEFAULTS.stop),
    afterMerge: strings('afterMerge', DEFAULTS.afterMerge),
    notify: oneOf('notify', ['off', 'milestones', 'all'] as const, DEFAULTS.notify),
  }
  return { config, problems }
}

export type Found = { scripts: Record<string, string>; makeTargets: string[]; ci: string; prose: string[] }

const RISKY = /\b(auth|session|migration|parser|concurrency|lock|payment|price|pricing|money|crypto|token)s?\b/i
const GATE_NAMES = ['check', 'verify', 'gate', 'ci']
const COMBO = ['build', 'typecheck', 'test', 'lint']
const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const NONE = 'none found; fill in'

const sentences = (prose: string[]) => prose.flatMap(p => p.split(/(?<=[.!?])\s+|\n+/)).map(s => s.trim()).filter(Boolean)

/** The directories a sentence names: tokens with a slash, as `dir/**` globs. */
function dirsIn(sentence: string): string[] {
  const out: string[] = []
  for (const raw of sentence.split(/[\s,;:()`'"]+/)) {
    const t = raw.replace(/[.!?]+$/, '')
    if (!t.includes('/') || /^https?:/.test(t) || t.startsWith('/')) continue
    const dir = t.replace(/\/\*\*$/, '').replace(/\/$/, '')
    if (/\.[a-z]+$/i.test(dir)) continue
    out.push(`${dir}/**`)
  }
  return out
}

/** The stop conditions a sentence lists after "ask the user only for", "stop and ask" or "ask only when". */
function stopsIn(sentence: string): string[] {
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

  for (const key of ['mainBranch', 'branch', 'protectedPaths', 'models', 'limits.silentMinutes', 'limits.taskMinutes', 'limits.itemTokens', 'afterMerge', 'notify']) sources[key] = 'default'

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
  const risky = [...new Set(lines.filter(s => RISKY.test(s)).flatMap(dirsIn))]
  config.riskyPaths = risky
  sources['riskyPaths'] = risky.length ? `prose naming risky code (${risky.length} director${risky.length === 1 ? 'y' : 'ies'})` : NONE

  const stops = [...new Set(lines.flatMap(stopsIn))]
  if (stops.length) {
    config.stop = stops
    sources['stop'] = 'prose: the "ask only for" list'
  } else sources['stop'] = 'default'

  const rounds = lines.map(s => /\b(\w+)\s+fix[- ]rounds?\b/i.exec(s)).find(Boolean)
  const n = rounds?.[1] ? (NUMBERS[rounds[1].toLowerCase()] ?? Number(rounds[1])) : NaN
  if (Number.isInteger(n) && n > 0) {
    config.limits.fixRounds = n
    sources['limits.fixRounds'] = `prose: "${rounds![0]}"`
  } else sources['limits.fixRounds'] = 'default'

  const auto = lines.find(s => /\bauto[- ]merge/i.test(s))
  if (auto) {
    config.merge = 'auto'
    sources['merge'] = 'prose: auto-merge'
  } else sources['merge'] = 'default'
  sources['mergeMethod'] = 'default'

  return { config, sources }
}
