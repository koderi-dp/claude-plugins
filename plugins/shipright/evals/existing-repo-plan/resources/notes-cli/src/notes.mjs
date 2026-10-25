import { TEXT_REQUIRED } from './messages.mjs'

export function addNote(notes, text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw new Error(TEXT_REQUIRED)
  return [...notes, { id: notes.length + 1, text: trimmed }]
}

export function listNotes(notes) {
  return notes.map(n => `${n.id}. ${n.text}`)
}
