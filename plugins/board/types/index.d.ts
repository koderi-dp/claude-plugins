export type ItemStatus = 'backlog' | 'next' | 'in_progress' | 'blocked' | 'done'
export type MilestoneStatus = 'planned' | 'active' | 'done'

export type Item = {
  id: string
  title: string
  status: ItemStatus
  note?: string
  ref?: string
  updatedAt?: string
  [k: string]: unknown
}

export type Milestone = {
  id: string
  title: string
  status: MilestoneStatus
  ref?: string
  branch?: string
  needs?: string[]
  size?: 'S' | 'M' | 'L'
  closes?: string[]
  items: Item[]
  [k: string]: unknown
}

export type Goal = { title: string; done: number; total: number }

export type Board = { version: 1; goal?: Goal; milestones: Milestone[]; [k: string]: unknown }

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  name: string
  model: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  calls: number
  activity: string
}

export type NativeTask = { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed' }

export type LiveAgent = { name: string; model: string; startedAt: string; activity: string }

export type LiveSession = {
  title: string
  cwd: string
  branch?: string
  item?: string
  startedAt: string
  seenAt: string
  agents: LiveAgent[]
}

export type Live = { sessions: Record<string, LiveSession> }

export type View = { kind: 'home' } | { kind: 'milestone'; id: string } | { kind: 'now' }

export type Panel = { view: View; isMoreShown: boolean; autoOpenedFor: string }

declare module 'claude-code' {
  interface PluginState {
    board: {
      board: Board | null
      boardError: string | null
      agents: AgentRun[]
      tasks: NativeTask[]
      live: Live
      panel: Panel
      now: number
      root: string
    }
  }
}
