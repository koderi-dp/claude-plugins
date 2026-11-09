export type ItemStatus = 'inbox' | 'ready' | 'planning' | 'building' | 'review' | 'merged' | 'blocked' | 'parked'
export type Item = { id: string; title: string; status: ItemStatus; size?: 'S' | 'M' | 'L'; needs?: string[]; source?: string; spec?: string | null; plan?: string | null; branch?: string | null; pr?: string | null; ledger?: string | null; note?: string; updatedAt?: string; [k: string]: unknown }
export type Backlog = { version: 1; items: Item[]; [k: string]: unknown }
export type Role = 'implementer' | 'reviewer' | 'final' | 'escalate'
export type ModelSpec = { model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'default' }
export type Runner = 'subagent' | 'session'
export type TaskReview = 'risky' | 'always' | 'off'
export type Config = { version: 1; mainBranch: string; branch: string; checks: { fast?: string; task?: string; gate?: string }; riskyPaths: string[]; protectedPaths: string[]; models: Record<Role, ModelSpec>; limits: { fixRounds: number; silentMinutes: number; taskMinutes: number; itemTokens: number; parallel: number }; runner: Runner; merge: 'auto' | 'pr'; mergeMethod: 'merge' | 'squash'; stop: string[]; afterMerge: string[]; retain: { plans: boolean; briefs: boolean; superpowers: boolean }; notify: 'off' | 'milestones' | 'all'; renameSession: boolean; taskReview: TaskReview; [k: string]: unknown }
export type Dispatch = { role: Role; model: string; effort: string; tokens: number; minutes: number; result: string; risky?: string; brief?: string; report?: string }
export type TaskRecord = { n: number; title: string; status: 'pending' | 'running' | 'fix' | 'accepted' | 'blocked'; commits?: string; dispatches: Dispatch[]; review?: { kind: 'lead-diff' | 'independent'; verdict: string; carried?: string[] } }
export type Ruling = { n: number; task?: number; text: string; why: string; costIfWrong: string }
export type Final = { verdict: string; gate?: string; tokens?: number; findings?: string[]; [k: string]: unknown }
export type Resume = { task: number; state: string; lastVerified?: string; at: string }
export type Ledger = { item: string; plan?: string; branch?: string; worktree?: string; base?: string; pr?: string | null; resume?: Resume; tasks: TaskRecord[]; rulings: Ruling[]; blockers: string[]; final?: Final | null; tokens: number; [k: string]: unknown }
export type SignalKind = 'silent' | 'dead' | 'looping' | 'budget'
export type Signal = { kind: SignalKind; agent: string; agentId?: string; detail: string; at: number; delivered: boolean }
export type AgentRun = { id: string; agentId?: string; name: string; model: string; status: 'running' | 'done' | 'failed'; startedAt: number; lastStepAt: number; endedAt?: number; calls: number; tokens: number; activity: string; lastCommands: string[]; failures: number }
export type LiveEntry = { title: string; cwd: string; branch?: string; item?: string; startedAt: string; seenAt: string; agents: AgentRun[]; signals: Signal[]; [k: string]: unknown }
export type Live = { sessions: Record<string, LiveEntry>; [k: string]: unknown }
export type ChildStatus = 'starting' | 'running' | 'stopped' | 'finished' | 'failed'
export type ChildSession = { id: string; item: string; worktree: string; branch: string; pid?: number; status: ChildStatus; startedAt: number; endedAt?: number; log: string; lastLine?: string }
export type Sibling = { sessionId: string; title: string; cwd: string; branch?: string; item?: string; seenAt: string; agents: AgentRun[]; signals: Signal[]; isStale: boolean }
export type View = 'overview' | 'queue' | 'history'
export type QueueFilter = 'inbox' | 'ready' | 'blocked' | 'parked' | 'all'
export type Panel = { view: View; filter: QueueFilter; search: string; expanded: string | null; isMoreShown: boolean; autoOpenedFor: string; isBandOpen: boolean }
declare module 'claude-code' {
  interface PluginState {
    pipeline: { root: string; config: Config | null; backlog: Backlog | null; fileError: string | null; agents: AgentRun[]; signals: Signal[]; children: ChildSession[]; siblings: Sibling[]; panel: Panel; now: number }
  }
}
