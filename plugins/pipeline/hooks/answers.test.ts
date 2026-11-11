// slimGet: the queue keys of the config.

import { expect, test } from 'claude-code/testing'

import { slimGet } from './answers'
import { DEFAULTS } from './config'

const input = (queue: 'file' | 'github') => ({ config: { ...DEFAULTS, queue, queueLabel: 'factory' }, backlog: null, readiness: {}, active: null, ledger: null, signals: [], children: [], siblings: [] })

test('get carries queue and queueLabel in github mode only', () => {
  expect(slimGet(input('github')).config).toMatchObject({ queue: 'github', queueLabel: 'factory' })
  const file = slimGet(input('file')).config as Record<string, unknown>
  expect('queue' in file).toBe(false)
  expect('queueLabel' in file).toBe(false)
})
