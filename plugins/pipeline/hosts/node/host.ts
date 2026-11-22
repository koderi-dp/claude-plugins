/**
 * The Host for a program that runs plugins in Node or Bun (opencode, pi): files, processes and the clock are Node's
 * own, the values of a session are kept in memory, and what only the program can do (tell the user something, name
 * the session, send a prompt) is given by the program's own folder under hosts/.
 */
import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { DirEntry, Host, RunResult, SpawnChunk, SpawnResult } from '../../core/host'
import type { Atom } from '../../core/state'
import { scopeSelf } from '../../core/engine'
import type { Self } from '../../core/engine'

export type NodeSession = {
  /** The program's id of the session. */
  id: string
  /** The folder the session works in. */
  cwd: string
  /** Where the pipeline may keep its own files (saved transcripts). */
  dataDir?: string
  /** The folder this plugin is installed in. */
  pluginRoot?: string
  /** The session's transcript as a file, where the program keeps one. */
  transcriptPath?: () => string | undefined
  /** A short notice to the user. */
  notify?: (text: string) => unknown
  /** Names the session. */
  rename?: (name: string) => unknown
  /** Sends a prompt into the session. */
  submit?: (text: string) => unknown
  /** Shows the pipeline's display, where the program has one. */
  reveal?: (reason: string) => unknown
}

const OUTPUT_CAP = 4_000_000

/** Runs a program to its end without a shell; a program that is not there answers exit 127 with the reason. */
function run(argv: readonly string[], init: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise(resolve => {
    const [program = '', ...args] = argv
    let stdout = ''
    let stderr = ''
    let isDone = false
    const end = (r: RunResult) => {
      if (isDone) return
      isDone = true
      resolve(r)
    }
    let child
    try {
      child = spawn(program, args, { cwd: init.cwd, env: init.env ? { ...process.env, ...init.env } : process.env, windowsHide: true, ...(init.timeoutMs ? { timeout: init.timeoutMs } : {}) })
    } catch (err) {
      return end({ exitCode: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
    }
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString('utf8')
    })
    child.on('error', err => end({ exitCode: 127, stdout, stderr: stderr || err.message }))
    child.on('close', (code, signal) => end({ exitCode: code ?? (signal ? 124 : 1), stdout, stderr: signal && !stderr ? `ended by ${signal}` : stderr, isStdoutTruncated: stdout.length >= OUTPUT_CAP, isStderrTruncated: stderr.length >= OUTPUT_CAP }))
    if (init.stdin !== undefined) child.stdin?.end(init.stdin)
    else child.stdin?.end()
  })
}

/** Runs a program and gives its output as it comes; leaving the loop early kills it. */
async function* stream(request: { argv: readonly string[]; cwd?: string; env?: Record<string, string>; input?: string }): AsyncGenerator<SpawnChunk, SpawnResult> {
  const [program = '', ...args] = request.argv
  const child = spawn(program, args, { cwd: request.cwd, env: request.env ? { ...process.env, ...request.env } : process.env, windowsHide: true })
  const queue: SpawnChunk[] = []
  let result: SpawnResult | null = null
  let wake: (() => void) | null = null
  const push = (c: SpawnChunk) => {
    queue.push(c)
    wake?.()
  }
  child.stdout?.on('data', (d: Buffer) => push({ stream: 'stdout', text: d.toString('utf8') }))
  child.stderr?.on('data', (d: Buffer) => push({ stream: 'stderr', text: d.toString('utf8') }))
  child.on('error', err => {
    push({ stream: 'stderr', text: err.message })
    result = { code: 127, signal: null }
    wake?.()
  })
  child.on('close', (code, signal) => {
    result = { code, signal }
    wake?.()
  })
  child.stdin?.end(request.input ?? '')
  try {
    for (;;) {
      while (queue.length) yield queue.shift()!
      if (result) return result
      await new Promise<void>(r => (wake = r))
      wake = null
    }
  } finally {
    if (!result) child.kill()
  }
}

const kindOf = (e: { isDirectory(): boolean; isFile(): boolean }): DirEntry['kind'] => (e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other')

// ---------- the values of each session ----------

type Scope = { values: Map<string, unknown>; self: Self | null }
const scopes = new Map<string, Scope>()
const current = new AsyncLocalStorage<Scope>()
let isScoped = false

function scopeOf(id: string): Scope {
  let s = scopes.get(id)
  if (!s) scopes.set(id, (s = { values: new Map(), self: null }))
  return s
}

/**
 * Runs `fn` as the session `id`: what the core keeps between calls (the item it works on, its caches) is that
 * session's, so one process can serve several sessions without mixing them.
 */
export function inSession<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (!isScoped) {
    isScoped = true
    const lone: Scope = { values: new Map(), self: null }
    scopeSelf(make => {
      const s = current.getStore() ?? lone
      return (s.self ??= make())
    })
  }
  return current.run(scopeOf(id), fn)
}

/** Forgets a session that ended. */
export const endSession = (id: string): void => void scopes.delete(id)

/** The Host of one session. */
export function nodeHost(session: NodeSession): Host {
  const values = scopeOf(session.id).values
  const keyOf = (a: Atom<unknown>) => `${a.ref.plugin}.${a.ref.key}`
  return {
    fs: {
      read: p => fs.readFile(p, 'utf8'),
      write: async (p, text) => {
        await fs.mkdir(path.dirname(p), { recursive: true })
        await fs.writeFile(p, text, 'utf8')
      },
      exists: async p => {
        try {
          await fs.access(p)
          return true
        } catch {
          return false
        }
      },
      list: async p => {
        const out: DirEntry[] = []
        for (const e of await fs.readdir(p, { withFileTypes: true })) {
          let size = 0
          let mtimeMs = 0
          try {
            const st = await fs.stat(path.join(p, e.name))
            size = st.size
            mtimeMs = st.mtimeMs
          } catch {}
          out.push({ name: e.name, kind: kindOf(e), size, mtimeMs, isLink: e.isSymbolicLink() })
        }
        return out
      },
    },
    clock: {
      now: async () => Date.now(),
      after: (ms, fn) => {
        const t = setTimeout(fn, ms)
        return { cancel: () => clearTimeout(t) }
      },
      every: (ms, fn) => {
        const t = setInterval(fn, ms)
        // The ticker never keeps the program alive.
        t.unref?.()
        return { cancel: () => clearInterval(t) }
      },
    },
    process: {
      run,
      spawn: stream,
      hookEnv: async () => ({ ...(session.dataDir ? { CLAUDE_PLUGIN_DATA: session.dataDir } : {}), ...(session.pluginRoot ? { CLAUDE_PLUGIN_ROOT: session.pluginRoot } : {}) }),
    },
    session: {
      id: async () => session.id,
      root: async () => session.cwd,
      cwd: async () => session.cwd,
      repo: async () => {
        // The main checkout, also from a worktree: the folder that holds the common .git.
        const common = await run(['git', '-C', session.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 15_000 })
        if (common.exitCode !== 0 || !common.stdout.trim()) return null
        const root = path.dirname(common.stdout.trim())
        const remote = await run(['git', '-C', session.cwd, 'remote', 'get-url', 'origin'], { timeoutMs: 15_000 })
        return { root, remote: remote.exitCode === 0 && remote.stdout.trim() ? remote.stdout.trim() : null }
      },
      info: async () => {
        const transcriptPath = session.transcriptPath?.()
        return transcriptPath ? { transcriptPath } : {}
      },
    },
    env: { get: async name => process.env[name] ?? (name === 'HOME' ? os.homedir() : undefined) },
    settings: { read: async () => undefined },
    state: {
      read: async a => (values.has(keyOf(a)) ? (values.get(keyOf(a)) as never) : a.initial),
      update: async (a, fn) => void values.set(keyOf(a), fn(values.has(keyOf(a)) ? (values.get(keyOf(a)) as never) : a.initial)),
    },
    ui: {
      toast: async text => {
        await session.notify?.(text)
      },
      reveal: async reason => {
        await session.reveal?.(reason)
      },
    },
    prompt: {
      submit: async input => {
        if (!session.submit) throw new Error('this program takes no prompt from a plugin')
        await session.submit(input.text)
      },
    },
    command: {
      run: async input => {
        if (!session.rename) return { deny: 'this program names no session from a plugin' }
        await session.rename(input.args)
        return { text: 'renamed' }
      },
    },
    // The programs this host serves offer none of Claude Code's notification, wake-up or task tools.
    tool: { list: async () => [], call: async input => ({ deny: `${input.tool} is not available in this program` }) },
  }
}
