export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  tier: string
  after: number[]
}

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
  /** The run id slices report under, made by the first `progress` call with a title. */
  run?: string
  /** A profile chosen for this run at the plan's handoff, over the saved one. */
  profile?: string
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

/** What a slice running in its own session last wrote to the bridge. */
export type SliceReport = {
  run: string
  slice: string
  title: string
  done: number
  total: number
  phase: string
  isFinished: boolean
  note?: string
  model: string
  costUsd: number
  contextTokens: number
  contextMax: number
  /** The workers the slice session runs, newest last, and how many run now. */
  crew: SliceWorker[]
  running: number
  /** The session ended because the main session asked it to stop. */
  isStopped: boolean
  startedAt: number
  updatedAt: number
  /** The titles of the slice's tasks, so the parent does not list them as planned. */
  tasks: string[]
}

/** One worker of a slice session, as its panel row would show it. */
export type SliceWorker = {
  description: string
  type: string
  model: string
  effort?: string
  status: AgentStatus
  stepDone?: number
  stepTotal?: number
  stepNote?: string
  costUsd: number
  contextTokens: number
  contextMax: number
  startedAt: number
  endedAt?: number
}

/** Set in a slice's own session by `progress({ run, slice })`: where it reports. */
export type Bridge = {
  run: string
  slice: string
  startedAt: number
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  isMoreShown: boolean
  autoOpenedFor: string
}

declare module 'claude-code' {
  interface PluginState {
    'superpowers-flow': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      now: number
      notify: boolean
      stats: Stats
      cache: Cache
      isHidden: boolean
      isBusy: boolean
      warned: number
      slices: SliceReport[]
      bridge: Bridge | null
    }
  }
}

export type Stats = {
  turn: number
  speed: number | null
  turnCost: number | null
  total: number
  context: number
  costAtStart: number
}

export type Cache = {
  expiresAt: number | null
  secondsLeft: number | null
}
