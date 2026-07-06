const KEY = 'work_whiteboard_draft_v1'

// Best-effort only — localStorage can be unavailable (private mode, quota),
// which must never block the actual paste/submit flow.
export function loadDraft() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveDraft(draft) {
  try {
    localStorage.setItem(KEY, JSON.stringify(draft))
  } catch {
    // ignore
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
