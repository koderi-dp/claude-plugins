// The prompts the commands hand the model.
import { TOOL } from './shared'

export const call = (input: Record<string, unknown>) => `${TOOL} ${JSON.stringify(input)}`

export const DISCUSS_PROMPT = (text: string) =>
  `Use the pipeline-discuss skill for this: "${text}". First tool call: ${call({ action: 'get', titles: true })} (is it an item already, or a new request). Then ask me about it one question at a time, show me the spec, and save it once I agree. Never start the build.`

export const INTAKE_PROMPT = (text: string) =>
  `Use the pipeline-intake skill for this request: "${text}". First tool call: ${call({ action: 'get', titles: true })} (the duplicate check: every item as id, status and title). Then add the item and write its spec as the skill says, and answer in one line (a thin request: with its first question, as the skill says). Never start the build.`

export const RUN_PROMPT = (target: string) =>
  `Use the pipeline-run skill. First tool call: ${call({ action: 'get' })}. Then ${target === 'all' ? 'run ready items until none is left' : target ? `run item ${target}` : 'run the first ready item'} as the skill says, from pick to merge, one line per turn.`

/**
 * What the model is told when the command itself began the item (mode direct): the tool's answer with the spec,
 * and the one call that ends the work. No skill is loaded and no `get` or `begin` is spent.
 */
export const DIRECT_PROMPT = (answer: string, id: string, isAll: boolean) =>
  `Pipeline item ${id} is claimed for this session and its worktree is ready. The tool answered:\n\n${answer}\n\n` +
  `Build it your own way, as you would with no plugin, working in that worktree: cd to it in your shell commands and use its path for file edits; do not call EnterWorktree. The spec's Acceptance list is what done means. If docs/pipeline/rules.md lists rules, they are the project's own. ` +
  `When it is built and its tests pass, make one call: ${TOOL} {"action":"ship","item":"${id}","message":"<commit message>","attribution":"<the attribution lines this session was given, copied as they are, one per line: the commit trailer and the pull request line>"${isAll ? ',"next":true' : ''}}. ` +
  `It commits what is uncommitted, runs the gate, opens the pull request and, where the config says so, waits for CI, merges and closes. Its answer says what is next: a red gate or red CI means fix and ship again; "review first" means make the Agent call it names, then ship with "verdict"${isAll ? '; a next item in the answer is built the same way' : ''}. ` +
  `Never edit the backlog or ledger files yourself. End with one line saying where the item stands.`

/**
 * What the model is told when the command itself began the item under mode full: the item is claimed and named
 * before the model's first word, and the skill drives from the plan on.
 */
export const BEGUN_PROMPT = (answer: string, id: string, isAll: boolean) =>
  `Use the pipeline-run skill. Pipeline item ${id} is already claimed for this session and its worktree is ready; do not call begin for it. The tool answered:

${answer}

` +
  `First tool call: ${call({ action: 'get' })} (the config and the open signals). Then run item ${id} as the skill says, from the plan to the merge${isAll ? ', and after it the ready items until none is left' : ''}, one line per turn.`

/** With runner session the lead only starts children: the mod's `start` does the worktree and the child does the rest. */
export const SESSION_RUN_PROMPT = (target: string) => {
  const what =
    target === 'all'
      ? 'each ready item in order up to limits.parallel children, and again for the next ready item each time a child finishes (the wake-up or the next get brings you back; a child that exited non-zero left its item blocked with the reason)'
      : target
        ? `item ${target}`
        : 'the first ready item'
  return `Use the pipeline-run skill with runner session. First tool call: ${call({ action: 'get' })}. Then call ${call({ action: 'start', item: '<id>' })} for ${what}; the child session does the planning, the build, the review and the PR in its worktree. Answer the tool's one line and stop; never run the item in this session.`
}

export const MIGRATE_PROMPT = `Use the pipeline-migrate skill. First tool call: ${call({ action: 'migrate' })}, which reads the project's queue, workflow prose and ledgers and drafts the config, the rules and the items without writing. Then finish the mapping, ask once, and apply as the skill says.`

export const MIGRATE_GITHUB_PROMPT = `Use the pipeline-migrate skill, its section "From a file backlog to issues". First tool call: ${call({ action: 'migrate-github' })}, which drafts the move of docs/pipeline/backlog.json onto GitHub issues without writing. Show the draft, ask once, then apply as that section says.`

export const INIT_PROMPT =
  `Set the pipeline up in this project with the pipeline-init skill: read it and follow its steps. If the project already has a queue, a workflow document or a ledger, it hands over to the pipeline-migrate skill, whose first tool call is ${call({ action: 'migrate' })}; otherwise its first tool call is ${call({ action: 'init' })}.`

export const STOP_PROMPT =
  `Pipeline stop, under the pipeline-run skill. First tool call: ${call({ action: 'get' })} for the active item and its resume block. Finish the task that is running: let a dispatched subagent finish or stop it at a safe point, start no other task. ` +
  `Leave the branch pushed and the ledger current: record where to resume with ${call({ action: 'ledger', item: '<id>', set: { resume: { task: '<n>', state: 'stopped by the user: <where>', lastVerified: '<sha>' } } })} as the last tool call. Then answer one line and stop.`

export const CLEAN_PROMPT =
  `Pipeline clean, under the pipeline-rules skill. First tool call: ${call({ action: 'clean' })}. It lists, one per line, the paths config.retain says may go for every merged item, the superpowers folders of merged plans, the worktrees of merged items and their local branches as branch:<name>, and deletes nothing. ` +
  'From the main checkout on mainBranch: remove each listed path with `git rm -r -q` (plain `rm -r` for an untracked one; `git worktree remove` for a worktree; `git branch -D <name>` for a `branch:` line), commit the removals on mainBranch with the attribution lines this session was given and no model identifier, and answer one line with the counts, as `cleaned: 3 folders, 1 plan, 1 worktree, 1 branch`. An answer of `nothing to clean` is the one line, and nothing is committed.'

export const QUEUE_PROMPT = (input: Record<string, unknown>) => `Under the pipeline-rules skill, make this one tool call: ${call(input)}. It answers one line; answer that line and nothing else.`
