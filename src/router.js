const NOTE_HASH_RE = /^#\/note\/(\d+)$/
const TACTICAL_HASH_RE = /^#\/note\/(\d+)\/tactical$/

export function getNoteIdFromHash() {
  const m = window.location.hash.match(NOTE_HASH_RE)
  return m ? Number(m[1]) : null
}

export function navigateToNote(id) {
  window.location.hash = `#/note/${id}`
}

// id=450 P0: 任務戰術盤 lives at its own route so it's deep-linkable and so
// closing the detail side panel (NOTE_HASH_RE no longer matching) and
// opening the tactical full-screen view are two independent, composable
// pieces of hash state instead of one widening the other's regex.
export function getTacticalNoteIdFromHash() {
  const m = window.location.hash.match(TACTICAL_HASH_RE)
  return m ? Number(m[1]) : null
}

export function navigateToTactical(id) {
  window.location.hash = `#/note/${id}/tactical`
}

export function clearNoteHash() {
  // Drop the fragment without adding a new history entry or reloading.
  history.replaceState(null, '', window.location.pathname + window.location.search)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export function onHashChange(callback) {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}
