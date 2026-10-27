import { expect, mock, test } from 'claude-code/testing'

const PROGRESS = 'mcp__superpowers-flow__progress'

// With `notify: milestones` an accepted task and the close each send one push; the
// test stands in for the PushNotification tool and says it delivered.
test('notify: an accepted task and the finish each push one line', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const pushed: string[] = []
  on('tool.call', { tool: 'PushNotification' }, (_$, e) => {
    pushed.push(String((e as { message?: string }).message))
    return { result: { pushSent: true } } as never
  })
  await $.command.run({ command: 'flow-notify', args: 'on' } as never)

  await $.tool.call({ tool: PROGRESS, title: 'Ship it', phase: 'delegate', total: 3 } as never)
  await $.tool.call({ tool: PROGRESS, done: 1 } as never)
  await $.tool.call({ tool: PROGRESS, phase: 'review' } as never)
  await $.tool.call({ tool: PROGRESS, done: 2 } as never)
  await $.tool.call({ tool: PROGRESS, finished: true } as never)
  // Pushes are fire-and-forget; let them land.
  await clock.settle()

  expect(pushed).toEqual(['Ship it: 1/3 accepted', 'Ship it: 2/3 accepted', 'Ship it: done'])
})

test('notify: off by default, nothing is pushed', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let pushes = 0
  on('tool.call', { tool: 'PushNotification' }, () => {
    pushes++
    return { result: { pushSent: true } } as never
  })
  await $.tool.call({ tool: PROGRESS, title: 'Ship it', phase: 'delegate', total: 3 } as never)
  await $.tool.call({ tool: PROGRESS, done: 1, finished: true } as never)
  await clock.settle()
  expect(pushes).toBe(0)
})
