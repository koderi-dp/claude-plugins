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
