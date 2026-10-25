import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStore, serializeStore } from '../src/store.mjs'

test('round trip', () => {
  const notes = [{ id: 1, text: 'a' }]
  assert.deepEqual(parseStore(serializeStore(notes)), notes)
})

test('corrupt store is empty', () => {
  assert.deepEqual(parseStore('{nope'), [])
})
