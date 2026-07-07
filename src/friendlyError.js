// Maps raw errors (Postgres/PostgREST/network) to short Chinese text a
// non-technical reader can act on. Raw detail still goes to the console for
// debugging — it just never reaches the user directly (id=432 §十).
export function friendlyErrorMessage(err) {
  const raw = (err && err.message) || String(err || '')
  console.error('[work-whiteboard]', err)

  if (/jwt|session|not authenticated|401/i.test(raw)) return '登入已失效，請重新登入後再試一次。'
  if (/row-level security|rls|permission denied|403/i.test(raw)) return '沒有權限執行這個操作。'
  if (/content.*(check|empty)/i.test(raw)) return '內容不可為空。'
  if (/recipient.*check/i.test(raw)) return '收件人不是有效的選項。'
  if (/network|fetch failed|failed to fetch|timeout/i.test(raw)) return '網路連線失敗，請稍後再試。'
  return '發生錯誤，請稍後再試。'
}
