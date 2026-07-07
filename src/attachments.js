import { supabase } from './supabaseClient.js'

const TABLE = 'work_whiteboard_attachments'
const BUCKET = 'whiteboard_attachments'

// Mirrors the bucket's own allowed_mime_types (id=430 §三) — checked
// client-side too so the user gets an answer before ever touching Storage.
export const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown']
// Browsers frequently report an empty file.type for .txt/.md depending on OS
// association, so extension is the fallback signal, not just MIME.
const EXTENSION_MIME_FALLBACK = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_FILES_PER_NOTE = 5
export const MAX_TOTAL_BYTES_PER_NOTE = 25 * 1024 * 1024

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp']
export const TEXT_MIME_TYPES = ['text/plain', 'text/markdown']

function extensionOf(filename) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename || '')
  return m ? m[1].toLowerCase() : ''
}

// Resolves a usable MIME type for a File, falling back to extension when the
// browser reports none (common for .md). Returns null if neither is on the
// whitelist — caller must reject the file before ever calling Storage.
export function resolveMimeType(file) {
  if (file.type && ALLOWED_MIME_TYPES.includes(file.type)) return file.type
  const ext = extensionOf(file.name)
  const fallback = EXTENSION_MIME_FALLBACK[ext]
  return fallback && ALLOWED_MIME_TYPES.includes(fallback) ? fallback : null
}

export async function listAttachments(noteId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('note_id', noteId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

// Path is {ownerUid}/{noteId}/{a fresh client-generated uuid}.{ext} — same
// shape as id=430 §七's convention. The uuid segment is generated here
// rather than reusing the metadata row's own primary key: `id` is
// server-generated (DEFAULT gen_random_uuid()) and deliberately not
// client-writable (see the migration's column grants), so there is no way
// to know it before the INSERT completes. Using a separate random uuid for
// the object name preserves every actual property the convention cares
// about — unguessable, no original filename in the path, one folder per
// owner/note — while sidestepping that ordering problem.
async function buildObjectPath(ownerUid, noteId, ext) {
  const uuid = crypto.randomUUID()
  return `${ownerUid}/${noteId}/${uuid}${ext ? '.' + ext : ''}`
}

export async function uploadAttachment({ noteId, ownerUid, file, mimeType }) {
  const ext = extensionOf(file.name)
  const objectPath = await buildObjectPath(ownerUid, noteId, ext)

  const { data: row, error: insertError } = await supabase
    .from(TABLE)
    .insert({
      note_id: noteId,
      object_path: objectPath,
      original_name: file.name,
      mime_type: mimeType,
      size_bytes: file.size,
      extension: ext || null,
      upload_status: 'pending',
    })
    .select()
    .single()
  if (insertError) throw insertError

  await runUpload(row, file, mimeType)
  return row.id
}

export async function retryUpload(attachment, file, mimeType) {
  await runUpload(attachment, file, mimeType)
}

async function runUpload(row, file, mimeType) {
  await supabase.from(TABLE).update({ upload_status: 'uploading' }).eq('id', row.id)

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(row.object_path, file, {
    contentType: mimeType,
    upsert: true,
  })

  if (uploadError) {
    await supabase.from(TABLE).update({ upload_status: 'failed' }).eq('id', row.id)
    throw uploadError
  }

  await supabase.from(TABLE).update({ upload_status: 'ready', uploaded_at: new Date().toISOString() }).eq('id', row.id)
}

export async function softDeleteAttachment(id) {
  const { error } = await supabase.from(TABLE).update({ deleted_at: new Date().toISOString() }).eq('id', id)
  if (error) throw error
}

// On-demand only — never cached, never persisted, never logged (id=430 §十 /
// id=431 §五). Called exactly when a thumbnail, download, or text preview is
// about to be rendered/fetched, and discarded right after.
export async function getSignedUrl(objectPath) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(objectPath, 300)
  if (error) throw error
  return data.signedUrl
}
