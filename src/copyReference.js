// Builds the "複製引用" clipboard text: a note id an agent can query on, a
// deep link a human can click, and a short title so it still reads once
// pasted into a chat. Never copies the note's full content — see id=427 §二.
function sanitizeTitleForCopy(title) {
  if (!title) return ''
  const oneLine = title.replace(/\s*\n\s*/g, ' ').trim()
  if (oneLine.length <= 60) return oneLine
  return oneLine.slice(0, 60) + '…'
}

export function buildReferenceText(note) {
  const title = sanitizeTitleForCopy(note.title)
  const firstLine = title ? `白板 note #${note.id}｜${title}` : `白板 note #${note.id}`
  const url = `${window.location.origin}${window.location.pathname}#/note/${note.id}`
  return `${firstLine}\n${url}`
}

async function fallbackCopy(text) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
}

export async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // fall through to fallback below
    }
  }
  await fallbackCopy(text)
}
