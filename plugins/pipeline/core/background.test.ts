import { expect, test } from 'claude-code/testing'

import { bgClock, bgEnd, bgReconcile, bgStart, checkPrompt, isDescribed, isLive, labelOf, notificationOf, shortPaths, tidyCommand } from './background'

test('0.7.1: a call without a description gets a short label from its command: a waiting loop is named, paths are shortened', () => {
  const loop = 'until grep -qE "Error|entry chunk|gzip" /tmp/claude-1000/-home-ubuntu-openhuddle/c1313393-1f20/tasks/bbx5qjixx.output; do sleep 5; done; tail -c 1200 /tmp/claude-1000/-home-ubuntu-openhuddle/c1313393-1f20/tasks/bbx5qjixx.output'
  expect(labelOf(loop)).toBe('Waits in a loop until: grep -qE "Error|entry chunk|gzip" …/bbx5qjixx.output')
  expect(labelOf('while ! curl -s localhost:3000 > /dev/null; do sleep 1; done')).toBe('Waits in a loop while: ! curl -s localhost:3000 > /dev/null')
  expect(labelOf('env PORT=1 node C:/Source/projects/app/dist/server.js --watch')).toBe('node …/server.js --watch')
  expect(labelOf(`node ${'x'.repeat(200)}`).length).toBe(91)
  expect(shortPaths('cat src/a.ts ./b.ts /one/two')).toBe('cat src/a.ts ./b.ts /one/two')
  const task = bgStart([], { id: 'b1', command: loop, at: 1 })[0]!
  expect(task.what).toBe('Waits in a loop until: grep -qE "Error|entry chunk|gzip" …/bbx5qjixx.output')
  expect(task.command).toBe(loop)
})

test('0.7.1: isDescribed: two words or more that are not the command itself', () => {
  expect(isDescribed('Wait for the build to finish', 'until grep x; do sleep 5; done')).toBe(true)
  expect(isDescribed('', 'npm run dev')).toBe(false)
  expect(isDescribed(undefined, 'npm run dev')).toBe(false)
  expect(isDescribed('build', 'npm run build')).toBe(false)
  expect(isDescribed('npm  run dev', 'npm run dev')).toBe(false)
})

test('tidyCommand: the program comes first, not the environment or the cd', () => {
  expect(tidyCommand('env APPDATA=C:/Users/ADMINI~1/AppData/Roaming  DOCKLET_SERVER_URL=http://localhost:9000 node server.js')).toBe('node server.js')
  expect(tidyCommand('PORT=3000 NODE_ENV="test env" npm run dev')).toBe('npm run dev')
  expect(tidyCommand('cd "C:/Source/my app" && env -u CI FOO=1 npx playwright test')).toBe('npx playwright test')
  expect(tidyCommand('export A=1 B=2; npm test')).toBe('npm test')
  expect(tidyCommand('npm run dev')).toBe('npm run dev')
  // Nothing but assignments: the line is kept as written.
  expect(tidyCommand('FOO=1')).toBe('FOO=1')
  expect(tidyCommand(`node ${'x'.repeat(500)}`).length).toBe(401)
})

test('bgStart, bgEnd: a task joins once and leaves by id; the description leads, the command stands in for a missing one', () => {
  const one = bgStart([], { id: 'bash_1', description: ' Start the\n dev server ', command: 'env PORT=1 npm run dev', agentId: 'a1', owner: 'Final review of item 31', at: 10 })
  expect(one).toEqual([{ id: 'bash_1', what: 'Start the dev server', command: 'npm run dev', owner: 'Final review of item 31', agentId: 'a1', startedAt: 10 }])
  expect(bgStart(one, { id: 'bash_1', command: 'other', at: 99 })).toBe(one)
  const two = bgStart(one, { id: 'bash_2', command: 'npm run watch', at: 20 })
  expect(two[1]).toEqual({ id: 'bash_2', what: 'npm run watch', command: 'npm run watch', owner: 'Lead', startedAt: 20 })
  expect(bgStart(two, { id: '', command: 'x', at: 1 })).toBe(two)
  expect(bgEnd(two, 'bash_1').map(t => t.id)).toEqual(['bash_2'])
  expect(bgEnd(two, 'nope')).toBe(two)
})

test('bgReconcile: what the engine no longer lists goes, a shell it lists joins, other kinds are not listed', () => {
  const list = bgStart(bgStart([], { id: 'bash_1', command: 'a', at: 1 }), { id: 'bash_2', command: 'b', at: 2 })
  const out = bgReconcile(
    list,
    [
      { id: 'bash_2', type: 'shell', status: 'running' },
      { id: 'bash_3', type: 'shell', status: 'running', description: 'Tail the log', command: 'tail -f x.log' },
      { id: 'agent_1', type: 'subagent', status: 'running' },
      { id: 'bash_4', type: 'shell', status: 'completed' },
    ],
    50,
  )
  expect(out.map(t => t.id)).toEqual(['bash_2', 'bash_3'])
  expect(out[1]).toMatchObject({ what: 'Tail the log', command: 'tail -f x.log', owner: 'Lead', startedAt: 50 })
  expect(bgReconcile(out, [{ id: 'bash_2', type: 'shell', status: 'running' }, { id: 'bash_3', type: 'shell', status: 'running' }], 60)).toBe(out)
  expect(bgReconcile(out, [], 60)).toEqual([])
})

test('notificationOf, isLive, bgClock, checkPrompt', () => {
  expect(notificationOf('<task-notification>\n<task-id>bash_7</task-id>\n<status>failed</status>\n</task-notification>')).toEqual({ id: 'bash_7', status: 'failed' })
  expect(notificationOf('<task-notification><task-id>bash_7</task-id></task-notification>')).toEqual({ id: 'bash_7', status: 'completed' })
  expect(notificationOf('the build finished')).toBeNull()
  expect(isLive('running')).toBe(true)
  expect(isLive('completed')).toBe(false)
  expect(isLive('killed')).toBe(false)
  expect([bgClock(45_000), bgClock(432_000), bgClock(3_840_000)]).toEqual(['45s', '7m 12s', '1h 04m'])
  const prompt = checkPrompt({ id: 'bash_1', what: 'Start the dev server', command: 'npm run dev', owner: 'Final review of item 31', startedAt: 0 }, 3_840_000)
  expect(prompt).toContain('Check background task bash_1 now. It has been running for 1h 04m: "Start the dev server" (`npm run dev`), started by Final review of item 31.')
  expect(prompt).toContain('finished, or stuck')
})
