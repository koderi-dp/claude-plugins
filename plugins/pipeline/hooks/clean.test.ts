import { expect, test } from 'claude-code/testing'

import type { Backlog, Config } from '../types'
import { cleanList, namesId } from './clean'
import { DEFAULTS } from './config'

const config = (retain: Partial<Config['retain']> = {}): Config => ({ ...structuredClone(DEFAULTS), retain: { ...DEFAULTS.retain, ...retain } })

const backlog: Backlog = {
  version: 1,
  items: [
    { id: 'p1', title: 'Login', status: 'merged', plan: 'docs/pipeline/plans/p1.md', pr: '#3' },
    { id: 'p2', title: 'Export', status: 'building', plan: 'docs/pipeline/plans/p2.md' },
    { id: 'p12', title: 'Search', status: 'merged', plan: 'docs/superpowers/plans/2026-11-01-search.md' },
  ],
}

const listing = [
  'docs/pipeline/ledgers/p1.json',
  'docs/pipeline/ledgers/p1/task-1-brief.md',
  'docs/pipeline/ledgers/p2.json',
  'docs/pipeline/ledgers/p2/task-1-brief.md',
  'docs/pipeline/ledgers/p12.json',
  'docs/pipeline/ledgers/p12/',
  'docs/pipeline/plans/p1.md',
  'docs/pipeline/plans/p2.md',
  'docs/superpowers/plans/2026-11-01-search.md',
  '.superpowers/sdd/2026-10-30-p1-login/',
  '.superpowers/sdd/2026-10-31-p120-other/progress.md',
  '.superpowers/sdd/2026-11-01-search/plan-path',
  '.superpowers/sdd/2026-11-02-export/plan-path',
  '.claude/worktrees/p2/',
]
const planPaths = {
  '2026-11-01-search': 'docs/superpowers/plans/2026-11-01-search.md\n',
  '2026-11-02-export': 'docs/pipeline/plans/p2.md\n',
  '2026-10-31-p120-other': '# Progress\n\nplan: docs/superpowers/plans/other.md\n',
}

test('a merged item with the default retain: its briefs, its superpowers folder, not its plan', async () => {
  const out = cleanList({ config: config(), backlog, item: 'p1', listing, planPaths })
  expect(out).toEqual(['docs/pipeline/ledgers/p1/', '.superpowers/sdd/2026-10-30-p1-login/'])
})

test('retain.plans off adds the plan; retain.briefs and retain.superpowers on keep the folders', async () => {
  expect(cleanList({ config: config({ plans: false }), backlog, item: 'p1', listing, planPaths })).toEqual(['docs/pipeline/ledgers/p1/', 'docs/pipeline/plans/p1.md', '.superpowers/sdd/2026-10-30-p1-login/'])
  expect(cleanList({ config: config({ briefs: true }), backlog, item: 'p1', listing, planPaths })).toEqual(['.superpowers/sdd/2026-10-30-p1-login/'])
  expect(cleanList({ config: config({ superpowers: true }), backlog, item: 'p1', listing, planPaths })).toEqual(['docs/pipeline/ledgers/p1/'])
  expect(cleanList({ config: config({ plans: true, briefs: true, superpowers: true }), backlog, item: 'p1', listing, planPaths })).toEqual([])
})

test('a superpowers folder is matched by its plan-path pointing at the item plan, and the worktree of a merged item goes', async () => {
  const out = cleanList({ config: config({ plans: false }), backlog, item: 'p12', listing, planPaths, worktrees: ['p12', 'p2'] })
  expect(out).toEqual(['docs/pipeline/ledgers/p12/', 'docs/superpowers/plans/2026-11-01-search.md', '.superpowers/sdd/2026-11-01-search/', '.claude/worktrees/p12/'])
})

test('the local branch of a merged item is listed as branch:<name> when it exists, from the item, its ledger or the config template', async () => {
  const withBranch: Backlog = { version: 1, items: [{ id: 'p1', title: 'Login', status: 'merged', branch: 'feat/own' }, { id: 'p12', title: 'Search', status: 'merged' }, { id: 'p2', title: 'Export', status: 'building', branch: 'feat/p2' }] }
  // The item's own branch, then the ledger's, then config.branch with the id.
  expect(cleanList({ config: config({ superpowers: true }), backlog: withBranch, listing: [], branches: ['feat/own', 'feat/p12', 'feat/p2', 'main'], ledgerBranches: { p12: 'feat/p12' } })).toEqual(['branch:feat/own', 'branch:feat/p12'])
  expect(cleanList({ config: config({ superpowers: true }), backlog: withBranch, item: 'p12', listing: [], branches: ['feat/p12'] })).toEqual(['branch:feat/p12'])
  // A branch that is not on disk, or mainBranch itself, is not listed.
  expect(cleanList({ config: config({ superpowers: true }), backlog: withBranch, listing: [], branches: ['main'] })).toEqual([])
  expect(cleanList({ config: { ...config({ superpowers: true }), branch: 'main' }, backlog: withBranch, item: 'p12', listing: [], branches: ['main'] })).toEqual([])
  // The worktree comes before the branch, after the folders.
  expect(cleanList({ config: config(), backlog: withBranch, item: 'p1', listing: ['docs/pipeline/ledgers/p1/x.md'], worktrees: ['p1'], branches: ['feat/own'] })).toEqual(['docs/pipeline/ledgers/p1/', '.claude/worktrees/p1/', 'branch:feat/own'])
})

test('a sweep takes every merged item and leaves the building one and the folders of other plans', async () => {
  const out = cleanList({ config: config(), backlog, listing, planPaths, worktrees: ['p2'] })
  expect(out).toEqual(['docs/pipeline/ledgers/p1/', '.superpowers/sdd/2026-10-30-p1-login/', 'docs/pipeline/ledgers/p12/', '.superpowers/sdd/2026-11-01-search/'])
  expect(out.some(p => p.includes('p2') || p.includes('export') || p.includes('p120'))).toBe(false)
})

test('nothing to clean: a building item, an unknown item, an empty listing, no backlog', async () => {
  expect(cleanList({ config: config(), backlog, item: 'p2', listing, planPaths })).toEqual([])
  expect(cleanList({ config: config(), backlog, item: 'p99', listing, planPaths })).toEqual([])
  expect(cleanList({ config: config({ plans: false }), backlog, listing: [], planPaths: {} })).toEqual([])
  expect(cleanList({ config: null, backlog: null, listing })).toEqual([])
})

test('without a config the defaults apply', async () => {
  expect(cleanList({ config: null, backlog, item: 'p1', listing, planPaths })).toEqual(['docs/pipeline/ledgers/p1/', '.superpowers/sdd/2026-10-30-p1-login/'])
})

test('namesId wants the id as its own token', async () => {
  expect(namesId('2026-10-30-p1-login', 'p1')).toBe(true)
  expect(namesId('p1', 'p1')).toBe(true)
  expect(namesId('2026-10-31-p120-other', 'p1')).toBe(false)
  expect(namesId('2026-10-31-p120-other', 'p12')).toBe(false)
  expect(namesId('P12_search', 'p12')).toBe(true)
})
