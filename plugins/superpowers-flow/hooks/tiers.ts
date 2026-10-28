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
  if (!roles.length && !tiers.length) return text
  const lines = ['## Settings from the user', '']
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
