import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addNote, listNotes } from '../src/notes.mjs'

test('addNote trims and numbers', () => {
  assert.deepEqual(addNote([], '  milk '), [{ id: 1, text: 'milk' }])
})

test('listNotes formats lines', () => {
  assert.deepEqual(listNotes([{ id: 1, text: 'a' }]), ['1. a'])
})
