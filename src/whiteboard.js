import { supabase } from './supabaseClient.js'

export const PROJECT_KEYS = ['medexam', 'surgical_pref_card', 'line_sdm', 'other']
export const SOURCE_TYPES = ['agent_chat', 'external_document', 'literature', 'human_idea', 'other']
// 'extracted' is excluded: it requires extracted_to (jsonb array), which is a
// Path B / server-side concern this POC never writes to — and per id=432 §三
// item 2, the UI must never let a human pick it directly anyway.
export const STATUSES = ['raw', 'triaged', 'archived']

// Mirrors the work_whiteboard_recipient_check CHECK constraint (id=426) —
// recipient is a controlled classification code, never an authorization
// grant (id=418 §9 / id=425 / id=427 §一). Also reused for the Compose "From"
// dropdown (id=432 §〇) — same list, same non-freeform rule.
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

export async function listNotes({ projectKey, status, sourceType, tag, trash, fromLabel, to, search } = {}) {
  let query = supabase.from(TABLE).select('*')
  query = trash ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null)
  query = query.order('created_at', { ascending: false })

  if (projectKey) query = query.eq('project_key', projectKey)
  if (status) query = query.eq('status', status)
  if (sourceType) query = query.eq('source_type', sourceType)
  if (tag) query = query.contains('tags', [tag])
  if (fromLabel) query = query.ilike('created_by_label', `%${fromLabel}%`)
  if (to === UNSET_RECIPIENT) query = query.is('recipient', null)
  else if (to) query = query.eq('recipient', to)
  if (search) {
    const escaped = search.replace(/[%,]/g, '')
    query = query.or(`title.ilike.%${escaped}%,content.ilike.%${escaped}%`)
  }

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

export async function createNote({ title, content, projectKey, sourceType, tags, recipient, createdByLabel }) {
  // Only writable columns per id=421 §2 / id=426 §2 / id=432 §〇 grants —
  // never send id / created_by_uid / last_modified_by / extracted_to /
  // created_at / updated_at. recipient and (as of id=432, create-time only)
  // created_by_label are both purely display/routing, never authorization.
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      title: title || null,
      content,
      project_key: projectKey,
      source_type: sourceType,
      tags,
      recipient: recipient || null,
      created_by_label: createdByLabel || null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

// Edit-time update (id=432 §一): title/content/project_key/source_type/
// recipient/tags only. created_by_uid/label, last_modified_by, extracted_to,
// and timestamps are never accepted here — created_by_label in particular is
// writable at creation (id=432 §〇) but that grant doesn't extend to
// UPDATE, so passing it here would just fail at the DB regardless.
const EDITABLE_FIELDS = ['title', 'content', 'projectKey', 'sourceType', 'recipient', 'tags']
const FIELD_TO_COLUMN = { projectKey: 'project_key', sourceType: 'source_type' }

export async function updateNote(id, fields) {
  const payload = {}
  for (const key of EDITABLE_FIELDS) {
    if (key in fields) payload[FIELD_TO_COLUMN[key] || key] = fields[key]
  }
  const { error } = await supabase.from(TABLE).update(payload).eq('id', id)
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

export async function restoreNote(id) {
  const { error } = await supabase.from(TABLE).update({ deleted_at: null }).eq('id', id)
  if (error) throw error
}

// Permanent removal — only ever called from the trash view, behind the
// two-step in-place confirmation (id=432 §二: no native confirm(), but this
// specific action keeps a deliberate second step).
export async function hardDeleteNote(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id)
  if (error) throw error
}
