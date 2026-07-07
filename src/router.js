const NOTE_HASH_RE = /^#\/note\/(\d+)$/

export function getNoteIdFromHash() {
  const m = window.location.hash.match(NOTE_HASH_RE)
  return m ? Number(m[1]) : null
}

export function navigateToNote(id) {
  window.location.hash = `#/note/${id}`
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
