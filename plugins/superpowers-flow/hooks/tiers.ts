// The settings that choose each role's tier and each tier's model and effort, as
// plain functions of the plugin's options, so tests can call them directly.

export const TIER_NAMES = ['fable', 'heavy', 'careful', 'medium', 'light'] as const
export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]
export type TierSettings = Record<string, { model?: string; effort?: Effort }>

// A tier left at `default` has no entry fields: it runs as its agent file says.
export const tierSettingsOf = (options: Record<string, unknown>): TierSettings =>
  Object.fromEntries(
    TIER_NAMES.map(t => {
      const model = options[`${t}Model`]
      const effort = options[`${t}Effort`]
      return [
        t,
        {
          model: MODELS.includes(model as never) ? (model as string) : undefined,
          effort: EFFORTS.includes(effort as never) ? (effort as Effort) : undefined,
        },
      ]
    }),
  )

// How each task is gated: `each` keeps superpowers' spec review then quality review per
// task; the others trade per-task review for speed and lean on the final review.
const REVIEW_MODES: Record<string, string[]> = {
  combined: [
    'Task reviews are combined: after each implementer reports DONE, dispatch **one** reviewer that checks spec compliance and code quality in a single pass (both templates\' checklists in one brief), instead of the spec reviewer followed by the quality reviewer. Its fix rounds and re-review work as superpowers says.',
  ],
  final: [
    'Task reviews are off for this run: after each implementer reports DONE, check its tests pass and its self-review raised nothing open, mark the task accepted and dispatch the next one. No spec or quality reviewer runs per task.',
    'The final whole-branch review still runs, and runs against the plan as the spec: it checks every task\'s requirements as well as code quality. Its findings go to one fixer and a re-review, as superpowers says. A task that comes back BLOCKED or DONE_WITH_CONCERNS still gets its usual handling.',
  ],
}

const ROLES: readonly [key: string, who: string][] = [
  ['coderTier', 'Coders (implementers, and fixers on a return round)'],
  ['reviewerTier', 'Task reviewers and re-reviewers'],
  ['finalReviewTier', 'The final whole-branch review'],
]

// The skill's text plus what the user chose: which tier each role runs on, and what
// each tier runs on (`describe` gives "Sonnet · medium"). Inserted before section 2;
// unchanged when every setting is at its default.
export const skillWithSettings = (
  text: string,
  options: Record<string, unknown>,
  settings: TierSettings,
  describe: (tier: string) => string,
): string => {
  const roles = ROLES.flatMap(([key, who]) => {
    const tier = options[key]
    return typeof tier === 'string' && TIER_NAMES.includes(tier as never) ? [`- ${who}: \`sp-${tier}\`.`] : []
  })
  const tiers = TIER_NAMES.flatMap(t => {
    const set = settings[t] ?? {}
    return set.model || set.effort ? [`- \`sp-${t}\` runs on ${describe(t)}.`] : []
  })
  const review = typeof options.taskReview === 'string' ? (REVIEW_MODES[options.taskReview] ?? []) : []
  if (!roles.length && !tiers.length && !review.length) return text
  const lines = ['## Settings from the user', '']
  if (review.length) lines.push(...review.flatMap(r => [r, '']))
  if (roles.length)
    lines.push(
      'These roles have a fixed tier and win over the table and over a tier a plan task names. Escalation still applies: after BLOCKED, or a third fix round, re-dispatch one tier up.',
      '',
      ...roles,
      '',
    )
  if (tiers.length) lines.push('The table\'s "Runs on" column is replaced for these tiers:', '', ...tiers, '')
  const block = lines.join('\n')
  const at = text.indexOf('\n## 2.')
  return at === -1 ? `${text}\n\n${block}` : `${text.slice(0, at)}\n\n${block}${text.slice(at)}`
}

// Each setting's default, as plugin.json declares it, for `/flow-config reset`.
export const CONFIG_DEFAULTS: Record<string, string> = {
  language: 'auto',
  notify: 'off',
  autoOpen: 'tier',
  coderTier: 'auto',
  reviewerTier: 'auto',
  finalReviewTier: 'auto',
  taskReview: 'each',
  ...Object.fromEntries(TIER_NAMES.flatMap(t => [[`${t}Model`, 'default'], [`${t}Effort`, 'default']])),
}

// `coderTier=medium mediumModel=sonnet` as pairs; a word without `=` is reported back.
export const parseConfigArgs = (args: string): { pairs: [key: string, value: string][]; bad: string[] } => {
  const pairs: [string, string][] = []
  const bad: string[] = []
  for (const word of args.trim().split(/\s+/).filter(Boolean)) {
    const m = /^([A-Za-z]+)=(\S+)$/.exec(word)
    if (m) pairs.push([m[1] ?? '', m[2] ?? ''])
    else bad.push(word)
  }
  return { pairs, bad }
}

// `superpowers-flow.coderTier`, or with the marketplace, to `coderTier`; null for another plugin's row.
export const fieldOf = (key: string): string | null => /^superpowers-flow(?:@[^.]+)?\.([A-Za-z]+)$/.exec(key)?.[1] ?? null
