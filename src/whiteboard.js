import { supabase } from './supabaseClient.js'

export const PROJECT_KEYS = ['medexam', 'surgical_pref_card', 'line_sdm', 'other']
export const SOURCE_TYPES = ['agent_chat', 'external_document', 'literature', 'human_idea', 'other']
// 'extracted' is excluded: it requires extracted_to (jsonb array), which is a
// Path B / server-side concern this POC never writes to.
export const STATUSES = ['raw', 'triaged', 'archived']

// Mirrors the work_whiteboard_recipient_check CHECK constraint (id=426) —
// recipient is a controlled classification code, never an authorization
// grant (id=418 §9 / id=425 / id=427 §一).
export const RECIPIENTS = [
  'Scribe-Claude',
  'Orchestrator-Claude',
  'KG-Claude',
  'Concept-Claude',
  'Entity-Claude',
  'Obsidian-Claude',
  'ExamGen-Claude',
  'UI-Claude',
  'Narrative-Claude',
  'Feedback-Claude',
  'Ambassador-Claude',
  'Tech-Claude',
  'Human-Jenbin',
  'GPT',
  'Codex',
  'Orchestrator-Assistant',
  'CC',
]

// Sentinel for the "To" filter's "未指名" option — recipient IS NULL, not a
// real recipient value, so it can't collide with the CHECK-constrained set.
export const UNSET_RECIPIENT = '__unset__'

const TABLE = 'work_whiteboard'

export async function listNotes({ projectKey, status, tag, trash, fromLabel, to } = {}) {
  let query = supabase.from(TABLE).select('*')
  query = trash ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null)
  query = query.order('created_at', { ascending: false })

  if (projectKey) query = query.eq('project_key', projectKey)
  if (status) query = query.eq('status', status)
  if (tag) query = query.contains('tags', [tag])
  if (fromLabel) query = query.ilike('created_by_label', `%${fromLabel}%`)
  if (to === UNSET_RECIPIENT) query = query.is('recipient', null)
  else if (to) query = query.eq('recipient', to)

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

export async function createNote({ title, content, projectKey, sourceType, tags, recipient }) {
  // Only writable columns per §2/id=426 §2 grants — never send id /
  // created_by_uid / created_by_label / last_modified_by / extracted_to /
  // created_at / updated_at. recipient is writable (id=426) and is purely a
  // routing/classification code, never an authorization grant.
  const { error } = await supabase.from(TABLE).insert({
    title: title || null,
    content,
    project_key: projectKey,
    source_type: sourceType,
    tags,
    recipient: recipient || null,
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
