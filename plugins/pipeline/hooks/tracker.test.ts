import { expect, test } from 'claude-code/testing'

import { NO_AUTH, NO_GH, close, comment, create, edit, editComment, ensureLabels, list, me, read, setBody } from './tracker'
import type { Run } from './tracker'

type Answer = { exitCode?: number; stdout?: string; stderr?: string } | null

/** A fake `run` that answers by the first three argv elements and records every argv it is given. */
const fake = (answers: Record<string, Answer>) => {
  const calls: string[][] = []
  const run: Run = async argv => {
    calls.push(argv)
    const a = answers[argv.slice(0, 3).join(' ')]
    if (a === null) return null
    if (a === undefined) throw new Error(`no answer for ${argv.join(' ')}`)
    return { exitCode: a.exitCode ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
  }
  return { run, calls }
}

const ISSUE = { number: 12, title: 'CSV export', body: 'We need it', author: { login: 'ann' }, labels: [{ name: 'pipeline' }], assignees: [], state: 'OPEN', url: 'https://github.com/o/r/issues/12', createdAt: '2026-11-01T10:00:00Z',
  comments: [{ author: { login: 'bob' }, authorAssociation: 'MEMBER', body: 'hi', createdAt: '2026-11-02T10:00:00Z', url: 'https://github.com/o/r/issues/12#issuecomment-900' }] }

test('list asks for the labelled open issues and maps them, oldest first', async () => {
  const { run, calls } = fake({ 'gh issue list': { stdout: JSON.stringify([{ ...ISSUE, number: 14 }, ISSUE]) } })
  const r = await list(run, 'pipeline')
  expect(calls[0]).toEqual(['gh', 'issue', 'list', '--label', 'pipeline', '--state', 'open', '--limit', '200', '--json', 'number,title,body,author,labels,assignees,state,url,createdAt,comments'])
  expect(r.ok && r.value.map(i => i.number)).toEqual([12, 14])
  expect(r.ok && r.value[0]).toMatchObject({ author: 'ann', labels: ['pipeline'], state: 'open', comments: [{ id: '900', author: 'bob', association: 'MEMBER', body: 'hi' }] })
})

test('read asks for one issue with the same fields', async () => {
  const { run, calls } = fake({ 'gh issue view': { stdout: JSON.stringify(ISSUE) } })
  const r = await read(run, 12)
  expect(calls[0]).toEqual(['gh', 'issue', 'view', '12', '--json', 'number,title,body,author,labels,assignees,state,url,createdAt,comments'])
  expect(r.ok && r.value.comments[0]).toEqual({ id: '900', author: 'bob', association: 'MEMBER', body: 'hi', at: '2026-11-02T10:00:00Z' })
})

test('create and comment read the number and the id from the URL gh prints', async () => {
  const { run, calls } = fake({ 'gh issue create': { stdout: 'https://github.com/o/r/issues/31\n' }, 'gh issue comment': { stdout: 'https://github.com/o/r/issues/31#issuecomment-77\n' } })
  expect(await create(run, { title: 'T', body: 'B', labels: ['pipeline'] })).toEqual({ ok: true, value: 31 })
  expect(calls[0]).toEqual(['gh', 'issue', 'create', '--title', 'T', '--body', 'B', '--label', 'pipeline'])
  expect(await comment(run, 31, 'text')).toEqual({ ok: true, value: '77' })
  expect(calls[1]).toEqual(['gh', 'issue', 'comment', '31', '--body', 'text'])
})

test('edit sends only the flags it was given, and none means no call', async () => {
  const { run, calls } = fake({ 'gh issue edit': { stdout: '' } })
  await edit(run, 12, { add: ['pipeline:building'], remove: ['pipeline:blocked', 'pipeline:needs-info'], assign: 'me' })
  expect(calls[0]).toEqual(['gh', 'issue', 'edit', '12', '--add-label', 'pipeline:building', '--remove-label', 'pipeline:blocked,pipeline:needs-info', '--add-assignee', 'me'])
  expect(await edit(run, 12, {})).toEqual({ ok: true, value: true })
  expect(calls.length).toBe(1)
  await edit(run, 12, { unassign: 'me' })
  expect(calls[1]).toEqual(['gh', 'issue', 'edit', '12', '--remove-assignee', 'me'])
})

test('setBody replaces the body of an issue', async () => {
  const { run, calls } = fake({ 'gh issue edit': { stdout: '' } })
  expect(await setBody(run, 12, 'new body')).toEqual({ ok: true, value: true })
  expect(calls[0]).toEqual(['gh', 'issue', 'edit', '12', '--body', 'new body'])
})

test('editComment patches by id; ensureLabels creates each with --force', async () => {
  const { run, calls } = fake({ 'gh api -X': { stdout: '{}' }, 'gh label create': { stdout: '' } })
  await editComment(run, '77', 'new')
  expect(calls[0]).toEqual(['gh', 'api', '-X', 'PATCH', 'repos/{owner}/{repo}/issues/comments/77', '-f', 'body=new'])
  await ensureLabels(run, ['a', 'b'])
  expect(calls.slice(1)).toEqual([['gh', 'label', 'create', 'a', '--force'], ['gh', 'label', 'create', 'b', '--force']])
})

test('me and close', async () => {
  const { run, calls } = fake({ 'gh api user': { stdout: 'ann\n' }, 'gh issue close': { stdout: '' } })
  expect(await me(run)).toEqual({ ok: true, value: 'ann' })
  expect(calls[0]).toEqual(['gh', 'api', 'user', '--jq', '.login'])
  expect(await close(run, 12)).toEqual({ ok: true, value: true })
  expect(calls[1]).toEqual(['gh', 'issue', 'close', '12'])
})

test('failures: no gh, not logged in, another error, bad output', async () => {
  expect(await list(fake({ 'gh issue list': null }).run, 'p')).toEqual({ ok: false, error: NO_GH })
  expect(await list(fake({ 'gh issue list': { exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' } }).run, 'p')).toEqual({ ok: false, error: NO_AUTH })
  expect(await list(fake({ 'gh issue list': { exitCode: 1, stderr: 'could not resolve host\nmore' } }).run, 'p')).toEqual({ ok: false, error: 'gh: could not resolve host' })
  expect(await list(fake({ 'gh issue list': { stdout: 'not json' } }).run, 'p')).toEqual({ ok: false, error: 'gh: unexpected output from issue list' })
  expect(await create(fake({ 'gh issue create': { stdout: 'nothing here' } }).run, { title: 'T', body: 'B', labels: [] })).toEqual({ ok: false, error: 'gh: unexpected output from issue create' })
})

test('an issue with no author, an empty body and no comments maps to empty values', async () => {
  const { run } = fake({ 'gh issue view': { stdout: JSON.stringify({ number: 5, title: 'T', body: '', author: null, labels: [], assignees: [], state: 'CLOSED', url: 'u', createdAt: 'c', comments: [] }) } })
  expect(await read(run, 5)).toEqual({ ok: true, value: { number: 5, title: 'T', body: '', author: '', labels: [], assignees: [], state: 'closed', url: 'u', createdAt: 'c', comments: [] } })
})
