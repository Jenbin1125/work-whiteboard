const KEY = 'work_whiteboard_sort_v1'

// Best-effort only — sessionStorage can be unavailable (private mode, quota),
// which must never block rendering. sessionStorage (not localStorage) is
// deliberate: it survives an F5 reload within the same tab but doesn't
// linger forever like a permanent preference would (id=445§⑤).
export function loadSortPref() {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw === 'created_desc' || raw === 'created_asc' ? raw : undefined
  } catch {
    return undefined
  }
}

export function saveSortPref(sort) {
  try {
    if (sort === undefined) sessionStorage.removeItem(KEY)
    else sessionStorage.setItem(KEY, sort)
  } catch {
    // ignore
  }
}
