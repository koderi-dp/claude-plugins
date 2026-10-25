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
