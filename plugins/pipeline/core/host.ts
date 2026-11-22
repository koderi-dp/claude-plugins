/**
 * What the pipeline asks of the program it runs in. Everything in core/ reaches files, processes, the clock, the
 * session and the user through a Host; each folder under hosts/ builds one for its program (Claude Code, opencode,
 * pi) and wires that program's events to the core.
 *
 * A host that lacks something answers the neutral value named on the member, and the core goes on without it.
 */
import type { Atom } from './state'

export type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean; isStderrTruncated?: boolean }
export type SpawnRequest = { argv: readonly string[]; cwd?: string; env?: Record<string, string>; input?: string }
export type SpawnChunk = { stream: 'stdout' | 'stderr'; text: string }
export type SpawnResult = { code: number | null; signal: string | null }
export type DirEntry = { name: string; kind: 'file' | 'dir' | 'other'; size?: number; mtimeMs?: number; isLink?: boolean }
export type Timer = { cancel: () => void }

/** A host tool the core calls by name; a host without it answers `{ deny }`. */
export type HostToolCall =
  | { tool: 'PushNotification'; message: string; status: 'proactive' }
  | { tool: 'ScheduleWakeup'; delaySeconds: number; reason: string; prompt: string }
  | { tool: 'TaskStop'; task_id: string }

export type Host = {
  fs: {
    read: (path: string) => Promise<string>
    write: (path: string, text: string) => Promise<void>
    exists: (path: string) => Promise<boolean>
    list: (path: string) => Promise<DirEntry[]>
  }
  clock: {
    now: () => Promise<number>
    after: (ms: number, fn: () => void) => Timer
    every: (ms: number, fn: () => void) => Timer
  }
  process: {
    /** Runs a program to its end; no shell. */
    run: (argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }) => Promise<RunResult>
    /** Runs a program and streams its output; ending the stream early kills it. */
    spawn: (request: SpawnRequest) => AsyncGenerator<SpawnChunk, SpawnResult>
    /** The environment the host gives a plugin: `CLAUDE_PLUGIN_DATA` is where the plugin may keep files, `CLAUDE_PLUGIN_ROOT` where it is installed. */
    hookEnv: () => Promise<Record<string, string>>
  }
  session: {
    id: () => Promise<string>
    /** The folder the session was started in. */
    root: () => Promise<string>
    /** The folder the session works in now. */
    cwd: () => Promise<string>
    /** The git repository of the session; null outside one. */
    repo: () => Promise<{ root: string; remote: string | null } | null>
    /** Where the session's transcript is kept, when the host keeps one as a file. */
    info: () => Promise<{ transcriptPath?: string }>
  }
  env: {
    /** One of `HOME`, `USERPROFILE`, `PIPELINE_CHILD`. */
    get: (name: 'HOME' | 'USERPROFILE' | 'PIPELINE_CHILD') => Promise<string | undefined>
  }
  settings: {
    /** The host's permission settings, for a child session to run under; undefined where there are none. */
    read: (input: { key: 'permissions' }) => Promise<unknown>
  }
  state: {
    read: <T>(a: Atom<T>) => Promise<T>
    update: <T>(a: Atom<T>, fn: (value: T) => T) => Promise<void>
  }
  ui: {
    /** A short notice to the user. */
    toast: (text: string) => Promise<unknown> | unknown
    /** Shows the pipeline's own display, when the host has one and the user has not turned that off. */
    reveal: (reason: string) => Promise<void>
  }
  prompt: {
    /** Sends a prompt into the session, as if the user typed it. */
    submit: (input: { text: string }) => Promise<unknown>
  }
  command: {
    /** Renames the session; a host that cannot answers `{ deny }` or throws. */
    run: (input: { command: 'rename'; args: string }) => Promise<unknown>
  }
  tool: {
    list: () => Promise<{ name: string }[]>
    call: (input: HostToolCall) => Promise<unknown>
  }
}
