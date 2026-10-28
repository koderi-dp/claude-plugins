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

// Speed profiles: each knob below defaults to `profile`, which follows these; any other
// value the user sets wins. `thorough` is superpowers as it ships.
export const PROFILES = {
  thorough: { taskReview: 'each', parallel: 'off', batchTasks: 'off', reReview: 'always', testScope: 'full', runner: 'subagent' },
  balanced: { taskReview: 'combined', parallel: 'independent', batchTasks: 'small', reReview: 'self', testScope: 'targeted', runner: 'worktree', finalReviewTier: 'careful' },
  fast: { taskReview: 'final', parallel: 'independent', batchTasks: 'small', reReview: 'self', testScope: 'targeted', runner: 'worktree', reviewerTier: 'light', finalReviewTier: 'careful' },
} as const satisfies Record<string, Record<string, string>>
export type ProfileName = keyof typeof PROFILES

const KNOBS: Record<string, readonly string[]> = {
  taskReview: ['each', 'combined', 'final'],
  parallel: ['off', 'independent'],
  batchTasks: ['off', 'small'],
  reReview: ['always', 'self'],
  testScope: ['full', 'targeted'],
  runner: ['subagent', 'worktree', 'session'],
}

const profileOf = (options: Record<string, unknown>): ProfileName =>
  typeof options.profile === 'string' && Object.hasOwn(PROFILES, options.profile) ? (options.profile as ProfileName) : 'thorough'

// What each knob and role resolves to: the user's value when it is one the knob takes,
// else the profile's. A role left at `auto` takes the profile's tier, if it names one.
export const effectiveOf = (options: Record<string, unknown>): Record<string, string> => {
  const profile: Record<string, string> = PROFILES[profileOf(options)]
  const out: Record<string, string> = {}
  for (const [knob, values] of Object.entries(KNOBS)) {
    const own = options[knob]
    out[knob] = typeof own === 'string' && values.includes(own) ? own : (profile[knob] ?? values[0] ?? '')
  }
  for (const [role] of ROLES) {
    const own = options[role]
    const tier = typeof own === 'string' && TIER_NAMES.includes(own as never) ? own : profile[role]
    if (tier) out[role] = tier
  }
  return out
}

// The brief line the mod reads to start a worker in its slice's worktree.
export const WORKTREE_LINE = /^Worktree: (\S.*?)\s*$/m

// The skill's words for each knob's value; `thorough`'s values add nothing.
const KNOB_TEXT: Record<string, Record<string, (e: Record<string, string>) => string[]>> = {
  taskReview: {
    combined: () => [
      "**One reviewer per task.** After each implementer reports DONE, dispatch **one** reviewer that checks spec compliance and code quality in a single pass. Superpowers 7's task reviewer already does; a superpowers that sends a spec reviewer and then a quality reviewer gets one reviewer with both checklists in one brief instead. Its fix rounds and re-review work as superpowers says.",
    ],
    final: () => [
      "**Task reviews are off for this run.** After each implementer reports DONE, check its tests pass and its self-review raised nothing open, mark the task accepted (`Task <N>: complete (commits <base7>..<head7>, task review off by setting)`) and dispatch the next one. No task reviewer runs. This overrides superpowers' rule never to skip the task review, for this run only: the user chose it.",
      "The final whole-branch review still runs, and runs against the plan as the spec: it checks every task's requirements as well as code quality. Its findings go to one fixer and a re-review, as superpowers says. A task that comes back BLOCKED or DONE_WITH_CONCERNS still gets its usual handling.",
    ],
  },
  parallel: {
    independent: e => [
      e.runner === 'subagent'
        ? "**Independent tasks run at once.** A task is ready when every task it depends on is accepted. Dispatch all ready tasks in one message, in the background, as long as the files their task texts name do not overlap: a task that shares a file with a running one waits for it. Record each one's BASE separately, review each as it reports, accept them in any order. This overrides superpowers' rule never to dispatch implementers in parallel, for tasks whose files are apart."
        : "**Independent slices run at once**, each in its own worktree (below): a slice starts as soon as the slices it depends on are merged, whether or not its files overlap with another running slice; overlaps are resolved at merge. This overrides superpowers' rule never to dispatch implementers in parallel: their worktrees keep them apart.",
    ],
  },
  batchTasks: {
    small: () => [
      '**Small tasks are batched.** Consecutive tasks that are mechanical (the `sp-light` row), touch one or two files and depend only on each other go to one implementer in one brief: every task text in order, one commit per task. They are reviewed together and accepted together. Never batch a task that needs judgment, or that the table puts on `sp-careful` or above.',
    ],
  },
  reReview: {
    self: () => [
      "**Small fixes are checked by you, not a re-review.** When every finding of a review is small and local (a rename, a missing check, a typo, a test assertion), read the fix round's diff yourself and close the round when it answers each finding; its ledger line says `self-checked`. Anything larger, and any spec gap, still gets superpowers' scoped re-review. This replaces the re-review only for those small rounds.",
    ],
  },
  testScope: {
    targeted: () => [
      "**Targeted tests per task.** Tell each implementer and fixer to run only the tests for the code it touched (the task's test file, or its package's tests), not the whole suite. The full suite runs once before the final review; its failures go to a fixer.",
    ],
  },
  runner: {
    worktree: () => [
      '**Slices run in worktrees.** Before the first dispatch, group the tasks into slices: a slice is a chain of tasks each depending on the one before; a small task that depends on nothing may join a neighbouring slice. For each slice, from the feature branch: `git worktree add .worktrees/<slice> -b <feature branch>-<slice>`, under `.worktrees/` at the repository root as superpowers:using-git-worktrees keeps it (git-ignored: check with `git check-ignore -q .worktrees`, and add it to `.gitignore` and commit if not). Put the line `Worktree: <absolute path of that worktree>` on a line of its own in every implementer, reviewer and fixer brief for the slice: the plugin starts that worker in the worktree.',
      'Slices whose dependencies are merged run at the same time; tasks inside a slice run in order. When a slice\'s last task is accepted, merge its branch into the feature branch (`git merge --no-ff`; resolve conflicts yourself, or with an `sp-careful` fixer when they touch logic), then `git worktree remove` it and delete its branch. The final review runs on the feature branch once every slice is merged.',
    ],
    session: () => [
      '**Slices run in their own Claude Code sessions.** Group the tasks into slices and make one worktree and branch per slice: a slice is a chain of tasks each depending on the one before; from the feature branch, `git worktree add .worktrees/<slice> -b <feature branch>-<slice>` (git-ignored, as superpowers:using-git-worktrees keeps `.worktrees/`). The first `progress` call\'s result names the run id and the bridge folder.',
      'For each slice whose dependencies are merged, start a headless session in its worktree, in the background (Bash with `run_in_background`):',
      '```\ncd <worktree> && SUPERPOWERS_FLOW_RUN=<run id> SUPERPOWERS_FLOW_SLICE=<slice> claude -p "<slice brief>" --permission-mode <mode> --output-format json > <bridge folder>/<slice>.log 2>&1\n```',
      'The two variables make the session report as that slice and follow this run\'s settings. A headless session cannot ask for permission: it runs on the same settings files and permission rules as this one, and whatever those do not allow is refused, not asked. `<mode>` is this session\'s own mode when it is `acceptEdits`, `auto`, `dontAsk` or `bypassPermissions`; when it is another, or you have had to ask the user for permissions in this run, ask the user once, before starting any, which mode the slice sessions may use. The slice brief:',
      '> You run slice "<slice>" of the plan <plan file> (run <run id>), in this worktree, on branch <slice branch>. Implement only tasks <numbers and titles>, with superpowers subagent-driven-development and the superpowers-flow skill: start no other sessions and no worktrees. Before the first dispatch call `mcp__superpowers-flow__progress` with `run: "<run id>"`, `slice: "<slice>"`, the title, total, tasks and phase; then `done` as each task is accepted, and `finished: true` at the end. Commit on your branch; do not merge, push or switch branches. End with: tasks done, commits, test result.',
      'The panel shows each slice from its own reports. When a slice\'s background command exits, read the end of its log, run the slice\'s tests on its branch, merge it into the feature branch (`git merge --no-ff`, then `git worktree remove` and delete its branch) and report its tasks as `done`. A slice that failed: read its log and finish its tasks yourself with workers whose briefs carry `Worktree: <its worktree>`. The final review runs on the feature branch once every slice is merged.',
    ],
  },
}

// The skill's text plus what the user chose: the profile's knobs, which tier each role
// runs on, and what each tier runs on (`describe` gives "Sonnet · medium"). Inserted
// before section 2; unchanged when every setting is at its default.
export const skillWithSettings = (
  text: string,
  options: Record<string, unknown>,
  settings: TierSettings,
  describe: (tier: string) => string,
): string => {
  const effective = effectiveOf(options)
  const flow = Object.keys(KNOBS).flatMap(knob => KNOB_TEXT[knob]?.[effective[knob] ?? '']?.(effective) ?? [])
  const roles = ROLES.flatMap(([key, who]) => {
    const tier = effective[key]
    return tier ? [`- ${who}: \`sp-${tier}\`.`] : []
  })
  const tiers = TIER_NAMES.flatMap(t => {
    const set = settings[t] ?? {}
    return set.model || set.effort ? [`- \`sp-${t}\` runs on ${describe(t)}.`] : []
  })
  if (!flow.length && !roles.length && !tiers.length) return text
  const lines = ['## Settings from the user', '']
  if (flow.length) {
    const profile = profileOf(options)
    lines.push(
      `How this run goes (profile \`${profile}\`${profile === 'thorough' ? '' : ', chosen for speed'}). These change superpowers' flow where they say so; everything else stays as superpowers says. The user's words for a run win over them.`,
      '',
      ...flow.flatMap(f => [f, '']),
    )
  }
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
  profile: 'thorough',
  ...Object.fromEntries(Object.keys(KNOBS).map(k => [k, 'profile'])),
  coderTier: 'auto',
  reviewerTier: 'auto',
  finalReviewTier: 'auto',
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
