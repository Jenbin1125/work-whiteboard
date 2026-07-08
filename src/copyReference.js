// Builds the "複製引用" clipboard text: a note id an agent can query on, a
// deep link a human can click, and a short title so it still reads once
// pasted into a chat. Never copies the note's full content — see id=427 §二.
function sanitizeTitleForCopy(title) {
  if (!title) return ''
  const oneLine = title.replace(/\s*\n\s*/g, ' ').trim()
  if (oneLine.length <= 60) return oneLine
  return oneLine.slice(0, 60) + '…'
}

// id=435 §二.2: "複製連結" copies just this — deliberately distinct from
// buildReferenceText() below, which bundles the id/title alongside it.
export function buildNoteLink(note) {
  return `${window.location.origin}${window.location.pathname}#/note/${note.id}`
}

export function buildReferenceText(note) {
  const title = sanitizeTitleForCopy(note.title)
  const firstLine = title ? `白板 note #${note.id}｜${title}` : `白板 note #${note.id}`
  return `${firstLine}\n${buildNoteLink(note)}`
}

// Attachment reference (id=431 §六): plain text only, never the signed URL —
// signed URLs expire in 5 minutes, so copying one would just paste a dead
// link. Anyone who needs the file re-opens the note to mint a fresh one.
export function buildAttachmentReferenceText(noteId, originalName) {
  return `白板 note #${noteId} 附件：${originalName}`
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
