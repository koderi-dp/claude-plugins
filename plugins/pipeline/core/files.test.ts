import { expect, test } from 'claude-code/testing'

import { hashRoot, livePath, parseJson, paths, places, serialize } from './files'

const ROOT = '/p/main'

test('paths names every project file under docs/pipeline', () => {
  const p = paths(ROOT)
  expect(p.dir).toBe('/p/main/docs/pipeline')
  expect(p.config).toBe('/p/main/docs/pipeline/config.json')
  expect(p.rules).toBe('/p/main/docs/pipeline/rules.md')
  expect(p.backlog).toBe('/p/main/docs/pipeline/backlog.json')
  expect(p.backlogMd).toBe('/p/main/docs/pipeline/BACKLOG.md')
  expect(p.specs).toBe('/p/main/docs/pipeline/specs')
  expect(p.plans).toBe('/p/main/docs/pipeline/plans')
  expect(p.ledgers).toBe('/p/main/docs/pipeline/ledgers')
  expect(p.spec('p12')).toBe('/p/main/docs/pipeline/specs/p12.md')
  expect(p.plan('p12')).toBe('/p/main/docs/pipeline/plans/p12.md')
  expect(p.ledger('p12')).toBe('/p/main/docs/pipeline/ledgers/p12.json')
  expect(p.ledgerDir('p12')).toBe('/p/main/docs/pipeline/ledgers/p12')
})

test('paths strips backslashes and a trailing slash from the root', () => {
  expect(paths('C:\\p\\main\\').config).toBe('C:/p/main/docs/pipeline/config.json')
})

test('livePath is under .git with a repository and under ~/.claude/pipeline without', async () => {
  const hash = await hashRoot(ROOT)
  expect(hash).toMatch(/^[0-9a-f]{12}$/)
  expect(await hashRoot(ROOT)).toBe(hash)
  expect(await hashRoot('/p/other')).not.toBe(hash)
  expect(livePath(ROOT, true, '/home/me', hash)).toBe('/p/main/.git/pipeline-live.json')
  expect(livePath(ROOT, false, '/home/me', hash)).toBe(`/home/me/.claude/pipeline/${hash}.json`)
})

test('parseJson returns the value for valid text', () => {
  const r = parseJson<{ a: number }>('{"a": 1}', 'x.json')
  expect(r).toEqual({ ok: true, value: { a: 1 } })
})

test('parseJson names the file and the line of a syntax error', () => {
  const text = '{\n  "version": 1,\n  "mainBranch": "main",\n  merge: "pr"\n}\n'
  const r = parseJson(text, 'docs/pipeline/config.json')
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toMatch(/^docs\/pipeline\/config\.json: line 4: /)
})

test('parseJson finds the line of a trailing comma, a missing comma and a cut-off file', () => {
  const comma = parseJson('{\n  "a": 1,\n}\n', 'f')
  if (!comma.ok) expect(comma.error).toMatch(/^f: line 3: /)
  const missing = parseJson('{\n  "a": 1\n  "b": 2\n}\n', 'f')
  if (!missing.ok) expect(missing.error).toMatch(/^f: line 3: /)
  const cut = parseJson('{\n  "a": [1,\n  2', 'f')
  if (!cut.ok) expect(cut.error).toMatch(/^f: line 3: /)
  expect([comma.ok, missing.ok, cut.ok]).toEqual([false, false, false])
})

test('parseJson rejects an empty file and trailing text with a line', () => {
  const empty = parseJson('', 'f')
  if (!empty.ok) expect(empty.error).toMatch(/^f: line 1: /)
  const trailing = parseJson('{"a": 1}\n\n}', 'f')
  if (!trailing.ok) expect(trailing.error).toMatch(/^f: line 3: /)
  expect([empty.ok, trailing.ok]).toEqual([false, false])
})

test('serialize indents by two and ends with a newline', () => {
  expect(serialize({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n')
})

test('places: file mode is docs/pipeline, github mode is .pipeline in the checkout and .git/pipeline for the tool', () => {
  const f = places('/r', 'file')
  expect([f.specRel('p1'), f.planRel('p1'), f.briefDir('p1'), f.recordsDir]).toEqual(['docs/pipeline/specs/p1.md', 'docs/pipeline/plans/p1.md', 'docs/pipeline/ledgers/p1', 'docs/pipeline'])
  expect([f.ledger('p1'), f.facts]).toEqual(['/r/docs/pipeline/ledgers/p1.json', '/r/docs/pipeline/facts.md'])
  const g = places('/r', 'github')
  expect([g.specRel('12'), g.planRel('12'), g.briefDir('12'), g.recordsDir]).toEqual(['.pipeline/12/spec.md', '.pipeline/12/plan.md', '.pipeline/12', '.pipeline'])
  expect([g.ledger('12'), g.facts, g.issues, g.items, g.exclude]).toEqual(['/r/.git/pipeline/12/ledger.json', '/r/.git/pipeline/facts.md', '/r/.git/pipeline/issues.json', '/r/.git/pipeline/items.json', '/r/.git/info/exclude'])
})
