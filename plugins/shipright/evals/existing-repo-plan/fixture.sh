#!/usr/bin/env bash
# A small existing project for the eval: a note-taking CLI with its own test script and conventions.
set -eu

mkdir -p src test

cat > package.json <<'EOF'
{
  "name": "notes-cli",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "check:release": "node --test"
  }
}
EOF

cat > CLAUDE.md <<'EOF'
# notes-cli conventions

- ES modules only (`.mjs`), no npm dependencies.
- All user-facing messages live in `src/messages.mjs` and are exported constants; never inline a message string elsewhere.
- Pure modules under `src/` never touch `process`, `fs` or the console; only `src/cli.mjs` does I/O.
- Tests use `node:test` and `node:assert/strict`, one file per module, named `test/<module>.test.mjs`.
EOF

cat > src/messages.mjs <<'EOF'
export const NOTE_ADDED = 'Note added'
export const NO_NOTES = 'No notes yet'
export const TEXT_REQUIRED = 'Note text is required'
EOF

cat > src/notes.mjs <<'EOF'
import { TEXT_REQUIRED } from './messages.mjs'

export function addNote(notes, text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw new Error(TEXT_REQUIRED)
  return [...notes, { id: notes.length + 1, text: trimmed }]
}

export function listNotes(notes) {
  return notes.map(n => `${n.id}. ${n.text}`)
}
EOF

cat > src/store.mjs <<'EOF'
export const STORE_FILE = '.notes.json'

export function parseStore(raw) {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function serializeStore(notes) {
  return JSON.stringify(notes)
}
EOF

cat > src/cli.mjs <<'EOF'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { addNote, listNotes } from './notes.mjs'
import { NOTE_ADDED, NO_NOTES } from './messages.mjs'
import { STORE_FILE, parseStore, serializeStore } from './store.mjs'

const [command, ...rest] = process.argv.slice(2)
const notes = existsSync(STORE_FILE) ? parseStore(readFileSync(STORE_FILE, 'utf8')) : []

if (command === 'add') {
  const next = addNote(notes, rest.join(' '))
  writeFileSync(STORE_FILE, serializeStore(next))
  console.log(NOTE_ADDED)
} else if (command === 'list') {
  const lines = listNotes(notes)
  console.log(lines.length ? lines.join('\n') : NO_NOTES)
} else {
  console.error(`Unknown command: ${command ?? ''}`)
  process.exit(1)
}
EOF

cat > test/notes.test.mjs <<'EOF'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addNote, listNotes } from '../src/notes.mjs'

test('addNote trims and numbers', () => {
  assert.deepEqual(addNote([], '  milk '), [{ id: 1, text: 'milk' }])
})

test('listNotes formats lines', () => {
  assert.deepEqual(listNotes([{ id: 1, text: 'a' }]), ['1. a'])
})
EOF

cat > test/store.test.mjs <<'EOF'
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
EOF
