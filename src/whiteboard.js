import { supabase } from './supabaseClient.js'

export const PROJECT_KEYS = ['medexam', 'surgical_pref_card', 'line_sdm', 'other']
export const SOURCE_TYPES = ['agent_chat', 'external_document', 'literature', 'human_idea', 'other']
// 'extracted' is excluded: it requires extracted_to (jsonb array), which is a
// Path B / server-side concern this POC never writes to.
export const STATUSES = ['raw', 'triaged', 'archived']

const TABLE = 'work_whiteboard'

export async function listNotes({ projectKey, status, tag } = {}) {
  let query = supabase.from(TABLE).select('*').is('deleted_at', null).order('created_at', { ascending: false })

  if (projectKey) query = query.eq('project_key', projectKey)
  if (status) query = query.eq('status', status)
  if (tag) query = query.contains('tags', [tag])

  const { data, error } = await query
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
