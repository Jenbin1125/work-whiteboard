// id=438: list-row preview extraction for 🏈 交棒卡-format notes. Pure
// string logic, no DOM/Supabase, so the row builder in main.js stays thin
// and this stays independently testable.

const FOOTBALL_MARKER = '🏈 交棒卡'
const TASK_LABEL_RE = /球（任務）\s*[:：]\s*/
const PREVIEW_MAX_LEN = 90 // id=438 §一.3 suggests 80–100; picked the midpoint

// Returns the capped「球（任務）」text for a 🏈-format note's content, or
// null when the note isn't 🏈-format or the label text can't be found —
// either way the caller falls back to its own existing preview logic
// (id=438 §一.2 "優雅降級": no error, no blank preview).
export function extractFootballPreview(content) {
  if (typeof content !== 'string' || !content.includes(FOOTBALL_MARKER)) return null
  const match = TASK_LABEL_RE.exec(content)
  if (!match) return null
  const rest = content.slice(match.index + match[0].length)
  const stop = /[•\n]/.exec(rest)
  const raw = (stop ? rest.slice(0, stop.index) : rest).trim()
  if (!raw) return null
  return raw.length > PREVIEW_MAX_LEN ? raw.slice(0, PREVIEW_MAX_LEN).trimEnd() + '…' : raw
}
