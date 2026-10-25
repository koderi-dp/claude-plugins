export type Phase = 'spec' | 'plan' | 'models' | 'branch' | 'build' | 'gate' | 'review' | 'pr' | 'done'

export type TaskStatus = 'pending' | 'active' | 'review' | 'done'

export type StepKind = 'code' | 'check' | 'review'

/** One thing the active task is doing or did: writing code, a narrow check, a review. */
export type Step = {
  kind: StepKind
  label: string
  startedAt: number
  endedAt: number | null
  result: 'pass' | 'fail' | null
  /** Test counts such as `14/14`, when the output was recognised. */
  detail: string | null
}

export type Task = {
  n: number
  title: string
  status: TaskStatus
  /** The task's narrow check from its `Done:` line, or null. */
  check: string | null
  startedAt: number | null
  doneAt: number | null
  /** Steps of the active task; cleared when it finishes, which shows as one line. */
  steps: Step[]
}

export type Progress = {
  root: string | null
  planPath: string | null
  feature: string | null
  branch: string | null
  phase: Phase | null
  tasks: Task[]
  startedAt: number | null
  buildStartedAt: number | null
  gate: 'running' | 'pass' | 'fail' | null
  gateCommand: string | null
  gateStartedAt: number | null
  gateEndedAt: number | null
  gateDetail: string | null
  reviewModel: string | null
  reviewStartedAt: number | null
  reviewEndedAt: number | null
  finishedBy: 'pr' | 'merge' | null
  activity: string
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    shipright: { progress: Progress; cwd: string | null; paneOpened: boolean }
  }
}
