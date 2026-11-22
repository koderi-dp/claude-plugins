// A PR merged by hand while the lead was elsewhere: the item sits in `review` (or `building` with a `pr`) and its
// Close never ran. Pure: the caller runs git through the `Git` function it passes; this picks the items worth
// checking, names the git calls and reads their answers. The caller throttles the fetch to one per `FETCH_MS`.

import type { Backlog, Item, Ledger } from '../types'

export type MergedPending = { id: string; branch: string; pr: string | null }

/** An item whose merge on `mainBranch` is worth checking, with the branch its item or ledger records. */
export type Candidate = { id: string; branch: string; pr: string | null }

/** How often `origin/<mainBranch>` is fetched before the check, per session. */
export const FETCH_MS = 60_000

/** The git runner the check needs: the exit code of `git -C <root> …`, or null when the call itself failed. */
export type Git = (argv: string[]) => Promise<{ exitCode: number } | null>

/** Whether the fetch is due: never within `FETCH_MS` of the last one. */
export const isFetchDue = (lastFetch: number, now: number): boolean => now - lastFetch >= FETCH_MS

const prOf = (item: Item, ledger: Ledger | null): string | null => (typeof item.pr === 'string' && item.pr ? item.pr : typeof ledger?.pr === 'string' && ledger.pr ? ledger.pr : null)
const branchOf = (item: Item, ledger: Ledger | null): string | null => (typeof item.branch === 'string' && item.branch ? item.branch : typeof ledger?.branch === 'string' && ledger.branch ? ledger.branch : null)

/**
 * The items to check: every `review` item, and every `building` item with a `pr`, when its item or its ledger
 * records a branch. Ledgers are given by item id; a missing one is null.
 */
export function candidates(backlog: Backlog | null, ledgers: Record<string, Ledger | null>): Candidate[] {
  const out: Candidate[] = []
  for (const item of backlog?.items ?? []) {
    const ledger = ledgers[item.id] ?? null
    const pr = prOf(item, ledger)
    if (item.status !== 'review' && !(item.status === 'building' && pr)) continue
    const branch = branchOf(item, ledger)
    if (!branch) continue
    out.push({ id: item.id, branch, pr })
  }
  return out
}

/** `git -C <root> fetch -q origin <mainBranch>`: the argv. */
export const fetchArgv = (root: string, mainBranch: string): string[] => ['git', '-C', root, 'fetch', '-q', 'origin', mainBranch]

/**
 * Whether a candidate's branch tip is on `mainBranch`: the tip is `refs/remotes/origin/<branch>` when that ref exists,
 * else the local branch; the base is `origin/<mainBranch>` when it exists, else the local one. `merge-base
 * --is-ancestor` answers 0 for merged, 1 for not; anything else, or a failed call, is unknown and reads as not merged.
 */
export async function isMerged(root: string, branch: string, mainBranch: string, git: Git): Promise<boolean> {
  const exists = async (ref: string) => (await git(['git', '-C', root, 'rev-parse', '--verify', '-q', ref]))?.exitCode === 0
  const tip = (await exists(`refs/remotes/origin/${branch}`)) ? `refs/remotes/origin/${branch}` : branch
  const base = (await exists(`refs/remotes/origin/${mainBranch}`)) ? `origin/${mainBranch}` : mainBranch
  const r = await git(['git', '-C', root, 'merge-base', '--is-ancestor', tip, base])
  return r?.exitCode === 0
}

/** The candidates found merged on `mainBranch`, in backlog order; a candidate whose check fails is left out. */
export async function findMerged(root: string, list: Candidate[], mainBranch: string, git: Git): Promise<MergedPending[]> {
  const out: MergedPending[] = []
  for (const c of list) {
    try {
      if (await isMerged(root, c.branch, mainBranch, git)) out.push({ id: c.id, branch: c.branch, pr: c.pr })
    } catch {
      // A failed call is unknown, not merged.
    }
  }
  return out
}

/** The one line the person reads at session start and in the status block. */
export const mergedLine = (m: MergedPending): string => `${m.id} merged on main · run /pipeline next or "continue the pipeline" to close it`
