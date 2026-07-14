const KEY = 'work_whiteboard_sort_v1'

// Best-effort only — sessionStorage can be unavailable (private mode, quota),
// which must never block rendering. sessionStorage (not localStorage) is
// deliberate: it survives an F5 reload within the same tab but doesn't
// linger forever like a permanent preference would (id=445§⑤).
//
// id=625: filters.sort is now always a concrete string, never undefined —
// 'id_desc' is the explicit default (was an implicit `undefined` meaning
// updated_desc before this ticket), so a maintainer reading `filters.sort`
// elsewhere never has to remember which sort an absent value used to imply.
export function loadSortPref() {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw === 'created_desc' || raw === 'created_asc' || raw === 'updated_desc' ? raw : 'id_desc'
  } catch {
    return 'id_desc'
  }
}

export function saveSortPref(sort) {
  try {
    if (sort === 'id_desc') sessionStorage.removeItem(KEY)
    else sessionStorage.setItem(KEY, sort)
  } catch {
    // ignore
  }
}
