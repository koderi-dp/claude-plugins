export type ItemStatus = 'inbox' | 'ready' | 'planning' | 'building' | 'review' | 'merged' | 'blocked' | 'parked'
export type Item = { id: string; title: string; status: ItemStatus; size?: 'S' | 'M' | 'L'; needs?: string[]; source?: string; spec?: string | null; plan?: string | null; branch?: string | null; pr?: string | null; ledger?: string | null; note?: string; updatedAt?: string; [k: string]: unknown }
export type Backlog = { version: 1; items: Item[]; [k: string]: unknown }
export type Role = 'implementer' | 'reviewer' | 'final' | 'escalate'
export type ModelSpec = { model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'default' }
export type Config = { version: 1; mainBranch: string; branch: string; checks: { fast?: string; task?: string; gate?: string }; riskyPaths: string[]; protectedPaths: string[]; models: Record<Role, ModelSpec>; limits: { fixRounds: number; silentMinutes: number; taskMinutes: number; itemTokens: number }; merge: 'auto' | 'pr'; mergeMethod: 'merge' | 'squash'; stop: string[]; afterMerge: string[]; notify: 'off' | 'milestones' | 'all'; [k: string]: unknown }
export type Dispatch = { role: Role; model: string; effort: string; tokens: number; minutes: number; result: string; risky?: string }
export type TaskRecord = { n: number; title: string; status: 'pending' | 'running' | 'fix' | 'accepted' | 'blocked'; commits?: string; dispatches: Dispatch[]; review?: { kind: 'lead-diff' | 'independent'; verdict: string; carried?: string[] } }
export type Ruling = { n: number; task?: number; text: string; why: string; costIfWrong: string }
export type Resume = { task: number; state: string; lastVerified?: string; at: string }
export type Ledger = { item: string; plan?: string; branch?: string; worktree?: string; base?: string; pr?: string | null; resume?: Resume; tasks: TaskRecord[]; rulings: Ruling[]; blockers: string[]; final?: { verdict: string; findings: string[] } | null; tokens: number; [k: string]: unknown }
export type SignalKind = 'silent' | 'dead' | 'looping' | 'budget'
export type Signal = { kind: SignalKind; agent: string; agentId?: string; detail: string; at: number; delivered: boolean }
export type AgentRun = { id: string; agentId?: string; name: string; model: string; status: 'running' | 'done' | 'failed'; startedAt: number; lastStepAt: number; endedAt?: number; calls: number; tokens: number; activity: string; lastCommands: string[]; failures: number }
export type Live = { session: string; startedAt: string; seenAt: string; item?: string; agents: AgentRun[]; signals: Signal[] }
export type Panel = { isMoreShown: boolean; autoOpenedFor: string }
declare module 'claude-code' {
  interface PluginState {
    pipeline: { root: string; config: Config | null; backlog: Backlog | null; fileError: string | null; agents: AgentRun[]; signals: Signal[]; panel: Panel; now: number }
  }
}
