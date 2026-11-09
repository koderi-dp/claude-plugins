// What `config.retain` says may go after an item merges (spec §4 `retain`, §10 `clean`). Pure:
// the caller lists the folders, reads the superpowers pointers and the local branches; this names the paths, and the
// branch as `branch:<name>`, and deletes nothing.

import type { Backlog, Config, Item } from '../types'
import { DEFAULTS } from './config'
import { branchOf } from './runner'

export type CleanInput = {
  config: Config | null
  backlog: Backlog | null
  /** One merged item's id; absent, every merged item. */
  item?: string
  /** Repo-relative paths as they are on disk, a directory with or without its trailing slash. */
  listing: string[]
  /** Per `.superpowers/sdd/<dir>`: the text of its `plan-path` file and `progress.md`, when there. */
  planPaths?: Record<string, string>
  /** The names under `.claude/worktrees/`. */
  worktrees?: string[]
  /** The local branches (`refs/heads/`), short names. */
  branches?: string[]
  /** Per item id, the branch its ledger records, for an item whose record has none. */
  ledgerBranches?: Record<string, string>
}

const LEDGERS = 'docs/pipeline/ledgers'
const PLANS = 'docs/pipeline/plans'
const SDD = '.superpowers/sdd'
const WORKTREES = '.claude/worktrees'

const trim = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')

/** The plan an item points at, or its default place. */
export const planOf = (item: Item): string => (typeof item.plan === 'string' && item.plan ? trim(item.plan) : `${PLANS}/${item.id}.md`)

/** Whether a folder name carries the id as its own token: `2026-11-05-p12-csv` has p12, `p120-x` does not. */
export function namesId(dir: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(dir)
}

/** The branch an item ran on: its own, else its ledger's, else `config.branch` with its id. */
export const itemBranch = (item: Item, ledgerBranch: string | undefined, template: string): string => (typeof item.branch === 'string' && item.branch ? item.branch : ledgerBranch || branchOf(template, item.id))

/**
 * The paths that may go: an item's ledger folder, plan, superpowers folders and worktree, each only when on disk and
 * not retained, then its local branch as `branch:<name>` when it exists and is not `mainBranch`.
 */
export function cleanList(input: CleanInput): string[] {
  const retain = { ...DEFAULTS.retain, ...(input.config?.retain ?? {}) }
  const paths = new Set(input.listing.map(trim).filter(Boolean))
  const has = (p: string) => paths.has(p) || [...paths].some(x => x.startsWith(`${p}/`))
  const sddDirs = [...new Set([...paths].filter(p => p.startsWith(`${SDD}/`)).map(p => p.slice(SDD.length + 1).split('/')[0]!).filter(Boolean))]
  const pointers = input.planPaths ?? {}
  const worktrees = new Set((input.worktrees ?? []).map(trim))
  const branches = new Set(input.branches ?? [])
  const template = input.config?.branch ?? DEFAULTS.branch
  const mainBranch = input.config?.mainBranch ?? DEFAULTS.mainBranch

  const merged = (input.backlog?.items ?? []).filter(i => i.status === 'merged')
  const chosen = input.item === undefined ? merged : merged.filter(i => i.id === input.item)

  const out: string[] = []
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p)
  }
  for (const item of chosen) {
    const plan = planOf(item)
    if (!retain.briefs && has(`${LEDGERS}/${item.id}`)) add(`${LEDGERS}/${item.id}/`)
    if (!retain.plans && has(plan)) add(plan)
    if (!retain.superpowers) {
      for (const dir of sddDirs) {
        const pointer = pointers[dir] ?? ''
        if (namesId(dir, item.id) || (pointer !== '' && pointer.includes(plan))) add(`${SDD}/${dir}/`)
      }
    }
    if (worktrees.has(item.id) || has(`${WORKTREES}/${item.id}`)) add(`${WORKTREES}/${item.id}/`)
    const branch = itemBranch(item, input.ledgerBranches?.[item.id], template)
    if (branch !== mainBranch && branches.has(branch)) add(`branch:${branch}`)
  }
  return out
}
