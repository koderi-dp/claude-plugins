// The settings that choose each role's tier and each tier's model and effort, as
// plain functions of the plugin's options, so tests can call them directly.

import type { Role, RoleModels } from '../types'

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

// Models and efforts per role for one run, chosen at the plan's handoff. A role left out
// is auto: the tier table picks per task. A brief names its worker's role in a line of its
// own (`Role: coder`), which the mod reads when the worker starts.
export const ROLE_NAMES: readonly Role[] = ['coder', 'reviewer', 'final']
export const ROLE_LINE = /^Role: (coder|reviewer|final)\b/m
const ROLE_WHO: Record<Role, string> = { coder: 'coders', reviewer: 'reviewers', final: 'final review' }

export const MODEL_PRESETS: Record<string, RoleModels> = {
  economy: { coder: { model: 'sonnet', effort: 'medium' }, reviewer: { model: 'sonnet', effort: 'high' }, final: { model: 'opus', effort: 'high' } },
  strong: { coder: { model: 'opus', effort: 'high' }, reviewer: { model: 'opus', effort: 'high' }, final: { model: 'fable', effort: 'high' } },
}

// What a call or a file says, kept only where it names a known model or effort.
export const cleanRoleModels = (v: unknown): RoleModels | undefined => {
  // A preset by name: `economy`, `strong`.
  if (typeof v === 'string') return Object.hasOwn(MODEL_PRESETS, v.toLowerCase()) ? MODEL_PRESETS[v.toLowerCase()] : undefined
  if (!v || typeof v !== 'object') return undefined
  const out: RoleModels = {}
  for (const role of ROLE_NAMES) {
    const r = (v as Record<string, unknown>)[role]
    if (!r || typeof r !== 'object') continue
    const { model, effort } = r as Record<string, unknown>
    const set = {
      ...(MODELS.includes(model as never) ? { model: model as string } : {}),
      ...(EFFORTS.includes(effort as never) ? { effort: effort as string } : {}),
    }
    if (set.model || set.effort) out[role] = set
  }
  return Object.keys(out).length ? out : undefined
}

const titled = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// "coders Sonnet · medium, final review Fable · high".
export const describeRoleModels = (m: RoleModels): string =>
  ROLE_NAMES.flatMap(role => {
    const r = m[role]
    return r ? [`${ROLE_WHO[role]} ${[r.model && titled(r.model), r.effort].filter(Boolean).join(' · ')}`] : []
  }).join(', ')

// For the progress result: how to mark the briefs so the choice reaches each worker.
export const roleModelsText = (m: RoleModels): string =>
  `Models for this run: ${describeRoleModels(m)}; any other role is auto. Put a line of its own in every brief naming its worker's role: \`Role: coder\` for implementers and fixers, \`Role: reviewer\` for task reviewers and re-reviewers, \`Role: final\` for the final whole-branch review. Keep choosing the \`sp-*\` tier by the table: the role's model and effort replace the tier's when the worker starts.`

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
      '**Slices run in their own Claude Code sessions.** Group the tasks into slices and make one worktree and branch per slice: a slice is a chain of tasks each depending on the one before; from the feature branch, `git worktree add .worktrees/<slice> -b <feature branch>-<slice>` (git-ignored, as superpowers:using-git-worktrees keeps `.worktrees/`). The first `progress` call\'s result names the run id and the log folder.',
      'For each slice whose dependencies are merged, start a headless session in its worktree: run `cd <worktree>` as a Bash call of its own (a `cd` and a redirect in one command need the user\'s approval), then this, in the background (Bash with `run_in_background`), then `cd` back to the repository root:',
      '```\nclaude -p "<slice brief>" --settings \'{"env":{"SUPERPOWERS_FLOW_RUN":"<run id>","SUPERPOWERS_FLOW_SLICE":"<slice>"}}\' --permission-mode <mode> --output-format stream-json --verbose > <log folder>/<slice>.log 2>&1 < /dev/null\n```',
      'The two variables in `--settings` make the session report as that slice and follow this run\'s settings; the log is what `/flow-log <slice>` and the panel\'s Log button show. A headless session cannot ask for permission: it runs on the same settings files and permission rules as this one, and whatever those do not allow is refused, not asked. `<mode>` is this session\'s own mode when it is `acceptEdits`, `auto`, `dontAsk` or `bypassPermissions`; when it is `default` or `plan`, ask the user once, before starting any, which mode the slice sessions may use. A launch the permission rules refuse is no reason to give up on the runner for the rest: run that slice with workers whose briefs carry `Worktree: <its worktree>`, and say so in one line. The slice brief:',
      '> You run slice "<slice>" of the plan <plan file> (run <run id>), in this worktree, on branch <slice branch>. Implement only tasks <numbers and titles>, with superpowers subagent-driven-development and the superpowers-flow skill: start no other sessions and no worktrees. Before the first dispatch call `mcp__superpowers-flow__progress` with `run: "<run id>"`, `slice: "<slice>"`, the title, total, tasks and phase; then `done` as each task is accepted, and `finished: true` at the end. Skip the final whole-branch review and finishing-a-development-branch: the main session reviews the merged branch. Commit on your branch; do not merge, push or switch branches. End with: tasks done, commits, test result.',
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
  const block = settingsBlock(options, settings, describe)
  if (!block) return text
  const at = text.indexOf('\n## 2.')
  return at === -1 ? `${text}\n\n${block}` : `${text.slice(0, at)}\n\n${block}${text.slice(at)}`
}

// The "Settings from the user" section alone; '' when every setting is at its default.
export const settingsBlock = (options: Record<string, unknown>, settings: TierSettings, describe: (tier: string) => string): string => {
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
  if (!flow.length && !roles.length && !tiers.length) return ''
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
  return lines.join('\n')
}

export const PROFILE_NAMES = Object.keys(PROFILES) as ProfileName[]

// A profile chosen for one run (at the plan's handoff) wins over the saved profile and
// over every knob and reviewer tier the user saved: they chose it for this run. The coder
// tier and each tier's model and effort stay as saved.
export const withRunProfile = (options: Record<string, unknown>, profile: string | undefined): Record<string, unknown> =>
  profile && PROFILE_NAMES.includes(profile as ProfileName)
    ? { ...options, profile, ...Object.fromEntries(Object.keys(KNOBS).map(k => [k, 'profile'])), reviewerTier: 'auto', finalReviewTier: 'auto' }
    : options

// superpowers:writing-plans ends by asking "Subagent-driven or Native?". Its Subagent-driven
// option becomes one per profile, with a recommendation read from the spec and the plan, and
// the chosen profile reaches this run through the first `progress` call. A wording this
// does not find gets the same as a section after the skill's own text.
const HANDOFF_OPTIONS = [
  '- **Subagent-driven · balanced** - one reviewer per task, independent slices in parallel git worktrees, small mechanical tasks batched, targeted tests per task, final review on `sp-careful`. The everyday choice.',
  '- **Subagent-driven · fast** - no per-task reviews, only the final whole-branch review against the plan; parallel slices and batching as balanced. Fastest and cheapest with subagents; for mechanical, well-specified plans.',
  '- **Subagent-driven · thorough** - superpowers as it ships: a fresh reviewer after every task, one task at a time, final review on `sp-fable`. Most careful.',
]

export const handoffWithProfiles = (text: string, saved: Record<string, unknown>): string => {
  const savedProfile = profileOf(saved)
  const runner = effectiveOf(saved).runner
  const rules = [
    '## superpowers-flow: execution profiles',
    '',
    'The superpowers-flow plugin runs Subagent-driven execution at one of three profiles; offer them in place of the single Subagent-driven option, Native kept as superpowers words it. Ask with AskUserQuestion when you have it: the recommended option first, its label ending "(Recommended)".',
    '',
    ...HANDOFF_OPTIONS,
    '',
    'Recommend one from the spec and the plan, and say why in one sentence:',
    '- **thorough** when a shipped mistake is expensive: security or authentication, payments or money, data migrations or deletes, concurrency, a public API or file format others depend on, unfamiliar or messy code, or little test coverage to catch a regression.',
    '- **fast** when the plan carries the complete code to write, its tasks are mechanical (one or two files each, clear tests), and a mistake is cheap to fix.',
    '- **balanced** otherwise, and when torn between two.',
    '- **Native** as superpowers says, when the tasks are tightly coupled through each other\'s interfaces.',
    `The user's saved profile is \`${savedProfile}\`${savedProfile === 'thorough' ? '' : ', so it is the default when the plan gives no reason for another'}. ${runner === 'session' ? 'Their runner is `session`: each slice runs in its own headless Claude Code session.' : 'When the plan splits into three or more large independent slices, mention that `/flow-config runner=session` would run each in its own session.'}`,
    '',
    '',
    'With a Subagent-driven option, ask in the same AskUserQuestion a second question, **Models for this run**:',
    '- **Auto (Recommended)** - the `sp-*` tier table picks per task: mechanical tasks on fast workers, reviews scaled to the diff, the final review on the strongest.',
    `- **Economy** - ${describeRoleModels(MODEL_PRESETS.economy ?? {})}. Cheaper; for well-specified plans.`,
    `- **Strong** - ${describeRoleModels(MODEL_PRESETS.strong ?? {})}. For hard or risky code.`,
    'The user may answer in their own words instead ("coders sonnet medium, final fable"): take the model (haiku, sonnet, opus, fable) and effort (low, medium, high, xhigh, max) they name per role; a role they leave out stays auto. Recommend Auto unless the spec makes a case: Strong beside thorough for risky code, Economy beside fast for a mechanical plan.',
    '',
    EGM_SPEC_RULE,
    '',
    '**If a Subagent-driven profile is chosen:** before the first dispatch, call `mcp__superpowers-flow__progress` with `profile: "<balanced|fast|thorough>"` along with the plan\'s title, total, tasks and phase `delegate`, and, unless models are Auto, `models`: `\"economy\"`, `\"strong\"`, or `{ coder, reviewer, final }` with each `{ model, effort }`. Its result carries that profile\'s instructions and how to mark the briefs for the models; they win over the superpowers-flow skill\'s settings section if it was loaded before. Then use superpowers:subagent-driven-development, as the plan says.',
  ].join('\n')
  const line = /^- \*\*Subagent-driven\*\*.*$/m
  if (!line.test(text)) return `${text}\n\n${rules}`
  return `${text.replace(line, HANDOFF_OPTIONS.join('\n')).replace('<one of the two>', '<one of the options above>')}\n\n${rules}`
}

// Each setting's default, as plugin.json declares it, for `/flow-config reset`.
export const CONFIG_DEFAULTS: Record<string, string> = {
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

// The Elephant-Goldfish Model (google/elephant-goldfish-model) designs and reviews a spec and
// stops there. Its review gets a last step that offers to build the approved design with
// superpowers; writing-plans (above) turns the design into tasks.
export const EGM_SPEC_RULE =
  '**A spec from EGM** (a design document with a `Detailed Implementation Plan`, `Implementation Plan`, `Work Breakdown` or `Implementation Steps` section, as `/egm-draft` writes it and `/egm-review` checks it): its decisions are reviewed and final, so do not reopen them or ask again what it settles. Build the tasks from its implementation plan: its phases become groups of tasks, and slices where they do not depend on each other; every file it lists lands in exactly one task; its test plan becomes the tasks\' failing tests. EGM plans carry no code: write the code into each task as superpowers asks. A design that passed EGM\'s Implementation Readiness stage with no open findings is the case for recommending `fast`.'

export const egmReviewWithBuild = (text: string): string =>
  [
    text,
    '',
    '## superpowers-flow: build the approved design',
    '',
    'EGM ends with an approved design; superpowers can build it. When the review is over and the design final (the user chose "Conclude review and finalize document" after Stage 9, the consolidated report is written, or a feature-spec-only review concluded after Stage 8), ask one more AskUserQuestion, after EGM\'s own gates, never inside one:',
    '',
    '- **Build this design with superpowers?** Options: **fast** (no per-task reviews: recommend it when Implementation Readiness passed with no open findings), **balanced** (one reviewer per task: recommend it when findings were resolved or a stage was skipped), **thorough** (superpowers as it ships: for designs whose review raised risk the user accepted), **Not now**.',
    '- In the same call, **Models for this run**: Auto (recommended), Economy, Strong, as the superpowers-flow plan handoff describes.',
    '',
    'A feature-spec-only review leaves no implementation plan: say the plan will be written from the design, and do not recommend `fast`.',
    '',
    'If they choose a profile: use superpowers:writing-plans with the design document as the plan\'s `**Spec:**`, telling it the execution method is already chosen (Subagent-driven · <profile>, models <choice>), so its handoff only asks the user to review the plan. Then run it with superpowers:subagent-driven-development, the first `mcp__superpowers-flow__progress` call carrying `profile` and, unless Auto, `models`. Skip superpowers:brainstorming: EGM did that work. Once it is built, `/egm:egm-drift-report` checks the code against the design.',
  ].join('\n')
