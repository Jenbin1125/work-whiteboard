import { supabase } from './supabaseClient.js'

export const PROJECT_KEYS = ['medexam', 'surgical_pref_card', 'line_sdm', 'other']
export const SOURCE_TYPES = ['agent_chat', 'external_document', 'literature', 'human_idea', 'other']
// 'extracted' is excluded: it requires extracted_to (jsonb array), which is a
// Path B / server-side concern this POC never writes to.
export const STATUSES = ['raw', 'triaged', 'archived']

const TABLE = 'work_whiteboard'

export async function listNotes({ projectKey, status, tag, trash } = {}) {
  let query = supabase.from(TABLE).select('*')
  query = trash ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null)
  query = query.order('created_at', { ascending: false })

  if (projectKey) query = query.eq('project_key', projectKey)
  if (status) query = query.eq('status', status)
  if (tag) query = query.contains('tags', [tag])

  const { data, error } = await query
  if (error) throw error
  return data
}

// Deep-link lookup: intentionally does NOT filter deleted_at, so callers can
// tell "soft-deleted" apart from "not found / no permission" (RLS already
// hides rows the current user doesn't own — a null result covers both
// nonexistent ids and other people's notes, which is the point: the caller
// must show the same message for both to avoid id enumeration).
export async function getNoteById(id) {
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

export async function createNote({ title, content, projectKey, sourceType, tags }) {
  // Only writable columns per §2 grants — never send id / created_by_uid /
  // created_by_label / last_modified_by / extracted_to / created_at / updated_at.
  const { error } = await supabase.from(TABLE).insert({
    title: title || null,
    content,
    project_key: projectKey,
    source_type: sourceType,
    tags,
  })
  if (error) throw error
}

export async function updateStatus(id, status) {
  const { error } = await supabase.from(TABLE).update({ status }).eq('id', id)
  if (error) throw error
}

export async function softDelete(id) {
  const { error } = await supabase.from(TABLE).update({ deleted_at: new Date().toISOString() }).eq('id', id)
  if (error) throw error
}
