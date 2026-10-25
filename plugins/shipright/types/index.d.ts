export type Phase = 'spec' | 'plan' | 'models' | 'branch' | 'build' | 'gate' | 'review' | 'pr' | 'done'

export type TaskStatus = 'pending' | 'active' | 'review' | 'done'

export type Task = { n: number; title: string; status: TaskStatus; doneAt: number | null }

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
  finishedBy: 'pr' | 'merge' | null
  activity: string
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    shipright: { progress: Progress; cwd: string | null; paneOpened: boolean }
  }
}
