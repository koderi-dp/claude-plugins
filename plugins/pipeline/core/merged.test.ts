import { expect, test } from 'claude-code/testing'

import type { Backlog, Ledger } from '../types'
import { FETCH_MS, candidates, fetchArgv, findMerged, isFetchDue, isMerged, mergedLine } from './merged'

const ROOT = '/p/main'

const backlog: Backlog = {
  version: 1,
  items: [
    { id: 'p1', title: 'Login', status: 'review', pr: '#3' },
    { id: 'p2', title: 'Export', status: 'building', pr: '#4' },
    { id: 'p3', title: 'Search', status: 'building' },
    { id: 'p4', title: 'No branch', status: 'review' },
    { id: 'p5', title: 'Merged', status: 'merged', branch: 'feat/p5', pr: '#1' },
    { id: 'p6', title: 'Own branch', status: 'review', branch: 'feat/own' },
  ],
}
const ledger = (id: string, set: Partial<Ledger>): Ledger => ({ item: id, tasks: [], rulings: [], blockers: [], tokens: 0, ...set })
const ledgers: Record<string, Ledger | null> = {
  p1: ledger('p1', { branch: 'feat/p1' }),
  p2: ledger('p2', { branch: 'feat/p2' }),
  p3: ledger('p3', { branch: 'feat/p3' }),
  p4: null,
  p5: ledger('p5', { branch: 'feat/p5' }),
}

/** A git that knows which refs exist and which branch tips are on origin/main; records every call. */
function fakeGit(options: { refs: string[]; merged: string[]; failing?: boolean }) {
  const calls: string[][] = []
  const git = async (argv: string[]) => {
    calls.push(argv)
    if (options.failing) return null
    const sub = argv[3]
    if (sub === 'rev-parse') return { exitCode: options.refs.includes(argv[6]!) ? 0 : 1 }
    if (sub === 'merge-base') return { exitCode: argv[6] === undefined ? 128 : options.merged.includes(argv[5]!) ? 0 : 1 }
    return { exitCode: 1 }
  }
  return { git, calls }
}

test('candidates: review items and building items with a pr, when the item or its ledger has a branch', async () => {
  expect(candidates(backlog, ledgers)).toEqual([
    { id: 'p1', branch: 'feat/p1', pr: '#3' },
    { id: 'p2', branch: 'feat/p2', pr: '#4' },
    { id: 'p6', branch: 'feat/own', pr: null },
  ])
  expect(candidates(null, {})).toEqual([])
  // The pr may come from the ledger too.
  expect(candidates({ version: 1, items: [{ id: 'p7', title: 'x', status: 'building' }] }, { p7: ledger('p7', { branch: 'feat/p7', pr: '#9' }) })).toEqual([{ id: 'p7', branch: 'feat/p7', pr: '#9' }])
})

test('isFetchDue: once per FETCH_MS', async () => {
  expect(isFetchDue(-Infinity, 0)).toBe(true)
  expect(isFetchDue(1000, 1000 + FETCH_MS - 1)).toBe(false)
  expect(isFetchDue(1000, 1000 + FETCH_MS)).toBe(true)
  expect(fetchArgv(ROOT, 'main')).toEqual(['git', '-C', ROOT, 'fetch', '-q', 'origin', 'main'])
})

test('isMerged prefers the remote tracking tip and origin/main, and falls back to the local refs', async () => {
  const remote = fakeGit({ refs: ['refs/remotes/origin/feat/p1', 'refs/remotes/origin/main'], merged: ['refs/remotes/origin/feat/p1'] })
  expect(await isMerged(ROOT, 'feat/p1', 'main', remote.git)).toBe(true)
  expect(remote.calls.at(-1)).toEqual(['git', '-C', ROOT, 'merge-base', '--is-ancestor', 'refs/remotes/origin/feat/p1', 'origin/main'])

  const local = fakeGit({ refs: [], merged: ['feat/p1'] })
  expect(await isMerged(ROOT, 'feat/p1', 'main', local.git)).toBe(true)
  expect(local.calls.at(-1)).toEqual(['git', '-C', ROOT, 'merge-base', '--is-ancestor', 'feat/p1', 'main'])

  const not = fakeGit({ refs: ['refs/remotes/origin/main'], merged: [] })
  expect(await isMerged(ROOT, 'feat/p1', 'main', not.git)).toBe(false)
})

test('findMerged answers the merged candidates in order and treats a failed call as not merged', async () => {
  const list = candidates(backlog, ledgers)
  const { git } = fakeGit({ refs: ['refs/remotes/origin/main'], merged: ['feat/p2', 'feat/own'] })
  expect(await findMerged(ROOT, list, 'main', git)).toEqual([
    { id: 'p2', branch: 'feat/p2', pr: '#4' },
    { id: 'p6', branch: 'feat/own', pr: null },
  ])
  expect(await findMerged(ROOT, list, 'main', fakeGit({ refs: [], merged: ['feat/p1'], failing: true }).git)).toEqual([])
  const throwing = async () => {
    throw new Error('no git')
  }
  expect(await findMerged(ROOT, list, 'main', throwing)).toEqual([])
})

test('mergedLine names the item and how to close it', async () => {
  expect(mergedLine({ id: 'p1', branch: 'feat/p1', pr: '#3' })).toBe('p1 merged on main · run /pipeline next or "continue the pipeline" to close it')
})
