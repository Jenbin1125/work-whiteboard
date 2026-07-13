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
  // id=538: meta_agent_registry v1.4 added this as a third identity
  // category (跨域整合型/企劃處式) — already live in the DB's
  // work_whiteboard_recipient_check CHECK constraint (verified before this
  // change), the frontend just hadn't been synced to it yet.
  'Cowork-Claude',
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

// id=434 §八: the list view only ever needs these — never extracted_to (a
// Path B / detail-only concern). The detail panel does its own full-row
// getNoteById() fetch below, so trimming here never starves it.
const LIST_COLUMNS = 'id, title, content, project_key, source_type, tags, status, recipient, created_by_label, created_at, updated_at, deleted_at'

export const PAGE_SIZE = 50

export async function listNotes({ projectKey, status, sourceType, tags, trash, fromLabel, to, search, sort, offset = 0, limit = PAGE_SIZE } = {}) {
  let query = supabase.from(TABLE).select(LIST_COLUMNS)
  query = trash ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null)

  if (projectKey) query = query.eq('project_key', projectKey)
  if (status) query = query.eq('status', status)
  if (sourceType) query = query.eq('source_type', sourceType)
  // .contains('tags', [...]) is Postgres array @> — already AND semantics
  // for however many tags are passed (id=433 §四.2), no extra logic needed.
  if (tags && tags.length) query = query.contains('tags', tags)
  if (fromLabel) query = query.ilike('created_by_label', `%${fromLabel}%`)
  if (to === UNSET_RECIPIENT) query = query.is('recipient', null)
  else if (to) query = query.eq('recipient', to)
  if (search) {
    const escaped = search.replace(/[%,]/g, '')
    query = query.or(`title.ilike.%${escaped}%,content.ilike.%${escaped}%`)
  }

  // id=434 §六: "最舊待整理" is a pure ordering choice here — the UI layer
  // pairs it with the status=raw filter above rather than this function
  // forcing it, so it never conflicts with an explicit status filter.
  if (sort === 'created_asc') query = query.order('created_at', { ascending: true })
  else if (sort === 'created_desc') query = query.order('created_at', { ascending: false })
  else query = query.order('updated_at', { ascending: false })

  query = query.range(offset, offset + limit - 1)

  const { data, error } = await query
  if (error) throw error
  return data
}

// id=434 §五: life-cycle counts for the status quick-tabs — explicitly not
// an unread/read tracker (id=432 §九 still shelved). 'extracted' is included
// because it's a real status humans should be able to glance at / filter by
// even though they can never set it from the UI (id=432 §三 item 2) — that
// rule is about the *editable* STATUSES list above, not this read-only one.
export const STATUS_TABS = ['raw', 'triaged', 'archived', 'extracted']

export async function getStatusCounts() {
  const results = await Promise.all(
    STATUS_TABS.map((s) => supabase.from(TABLE).select('id', { count: 'exact', head: true }).is('deleted_at', null).eq('status', s))
  )
  const counts = {}
  STATUS_TABS.forEach((s, i) => {
    const { count, error } = results[i]
    if (error) throw error
    counts[s] = count || 0
  })
  return counts
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

// id=440 §1.2's manual reply-target search — by title (ilike) or exact id
// (numeric query), per the spec's literal "依標題或 id". excludeId keeps a
// note being edited off its own candidate list (§1.2's self-reference
// guard); Compose has no excludeId since a brand-new note has no id yet.
export async function searchNotesForReply(query, { excludeId } = {}) {
  const q = (query || '').trim()
  if (!q) return []
  let sel = supabase.from(TABLE).select('id, title, content').is('deleted_at', null)
  sel = /^\d+$/.test(q) ? sel.eq('id', Number(q)) : sel.ilike('title', `%${q.replace(/[%,]/g, '')}%`)
  const { data, error } = await sel.order('created_at', { ascending: false }).limit(8)
  if (error) throw error
  return excludeId ? data.filter((n) => n.id !== excludeId) : data
}

// id=439 §四's forward-link query verbatim (deleted_at IS NULL filter).
// Columns widened by id=441 (status/recipient/reply_to_note_id) so the same
// function serves both id=440's simple one-level list and id=441's
// tree-scan/badge rendering without a second near-duplicate query.
export async function listReplies(noteId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, title, content, status, recipient, reply_to_note_id, created_at')
    .eq('reply_to_note_id', noteId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

// id=441 §7.3: P0's reply-context sidebar reads reply_to_note_id via plain
// iterative SELECTs — explicitly NOT a recursive CTE and NOT a new RPC (GPT
// #116 confirmed no reply-tree RPC exists in public schema; id=439 §四's CTE
// was only ever a reference example for direct SQL-tool use, never exposed
// to the frontend). Every step here is a normal query already covered by
// existing RLS, no bypass.
const REPLY_TRAIL_DEPTH_CAP = 20 // §7.3 point 5 — upward trail depth only
export const REPLY_TREE_NODE_CAP = 100 // §7.3 point 6 — total nodes scanned for the sidebar

// Walks reply_to_note_id upward from `note` until reaching a root
// (reply_to_note_id IS NULL), or an id=441 §二 exception: parent missing/
// soft-deleted ("parent_unavailable"), a cycle ("cycle" — a note pointing
// back at one already seen), or the depth cap ("depth_exceeded"). Returns
// the trail root-first (excluding `note` itself) plus which exception (if
// any) cut the climb short — the caller still renders whatever partial
// trail was found, per §二's "同一句，不區分兩者" minimal-disclosure rule.
export async function getReplyTrailUp(note) {
  const trail = []
  const visited = new Set([note.id])
  let current = note
  let anomaly = null
  while (current.reply_to_note_id) {
    if (trail.length >= REPLY_TRAIL_DEPTH_CAP) {
      anomaly = 'depth_exceeded'
      break
    }
    const parent = await getNoteById(current.reply_to_note_id)
    if (!parent || parent.deleted_at) {
      anomaly = 'parent_unavailable'
      break
    }
    if (visited.has(parent.id)) {
      anomaly = 'cycle'
      break
    }
    visited.add(parent.id)
    trail.unshift(parent)
    current = parent
  }
  return { trail, anomaly }
}

// Breadth-first, level-by-level scan of every descendant reachable from
// `rootId` — still just repeated listReplies() calls (iterative fetch, per
// §7.3), never a recursive query. This is deliberately broader than what
// the sidebar visually renders (§7.2 caps the *display* to direct children
// only): §1.3's pending-leaf determination is unmodified by §七 and still
// needs the whole tree to avoid understating "N 條分支待處理" to whatever
// happens to be on-screen. Capped at REPLY_TREE_NODE_CAP total nodes;
// `nodesById.has(...)` doubles as the cycle guard (a node already recorded
// is never re-queued), so a cycle simply stops that branch rather than
// looping — no separate depth counter needed for the downward direction.
export async function scanReplyTree(rootId) {
  const nodesById = new Map()
  const childrenOf = new Map()
  const root = await getNoteById(rootId)
  if (!root || root.deleted_at) return { nodesById, childrenOf, truncated: false }
  nodesById.set(root.id, root)

  let frontier = [root.id]
  let truncated = false
  while (frontier.length && !truncated) {
    const next = []
    for (const id of frontier) {
      const children = await listReplies(id)
      const childIds = []
      for (const child of children) {
        if (nodesById.has(child.id)) continue // already seen — cycle guard
        if (nodesById.size >= REPLY_TREE_NODE_CAP) {
          truncated = true
          break
        }
        nodesById.set(child.id, child)
        childIds.push(child.id)
        next.push(child.id)
      }
      childrenOf.set(id, childIds)
      if (truncated) break
    }
    frontier = next
  }
  return { nodesById, childrenOf, truncated }
}

// id=441 §1.3's pending-leaf-node rule, computed over an already-scanned
// tree (see scanReplyTree): unresolved status with no non-deleted direct
// reply of its own. Pure function, no I/O — the scan already excludes
// soft-deleted rows, so "no child in childrenOf" already means "no
// non-deleted direct reply".
export function findPendingLeaves(nodesById, childrenOf) {
  const leaves = []
  for (const note of nodesById.values()) {
    const isUnresolved = note.status === 'raw' || note.status === 'triaged'
    const hasChildren = (childrenOf.get(note.id) || []).length > 0
    if (isUnresolved && !hasChildren) leaves.push(note)
  }
  return leaves
}

// id=463 §五: P1 v1's sole data source — a read-only view, not a new query
// definition. Both the constellation summary and the flat list (main.js)
// derive from one call to this per render, so the two never show a
// different ball count for the same recipient (id=463§〇/§七.1). SELECT
// only, matching this view's grants (§6 gate already verified RLS gates it
// correctly for real JWTs — see id=453§6/§7).
const GLOBAL_BALLS_VIEW = 'v_global_pending_balls'
const GLOBAL_BALLS_COLUMNS = 'note_id, title, recipient, status, task_type_hint, created_at, updated_at, reply_to_note_id, queried_at'

export async function listGlobalPendingBalls() {
  const { data, error } = await supabase.from(GLOBAL_BALLS_VIEW).select(GLOBAL_BALLS_COLUMNS).order('created_at', { ascending: true })
  if (error) throw error
  return data
}

export async function createNote({ title, content, projectKey, sourceType, tags, recipient, createdByLabel, replyToNoteId }) {
  // Only writable columns per id=421 §2 / id=426 §2 / id=432 §〇 / id=439 §三
  // grants — never send id / created_by_uid / last_modified_by /
  // extracted_to / created_at / updated_at. recipient and reply_to_note_id
  // are both purely display/routing/structural, never authorization
  // (id=439 §三's column comment is explicit about this for the latter).
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
      reply_to_note_id: replyToNoteId || null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

// Edit-time update (id=432 §一, id=440 §一.2): title/content/project_key/
// source_type/recipient/tags/reply_to_note_id only. created_by_uid/label,
// last_modified_by, extracted_to, and timestamps are never accepted here —
// created_by_label in particular is writable at creation (id=432 §〇) but
// that grant doesn't extend to UPDATE, so passing it here would just fail
// at the DB regardless.
const EDITABLE_FIELDS = ['title', 'content', 'projectKey', 'sourceType', 'recipient', 'tags', 'replyToNoteId']
const FIELD_TO_COLUMN = { projectKey: 'project_key', sourceType: 'source_type', replyToNoteId: 'reply_to_note_id' }

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
