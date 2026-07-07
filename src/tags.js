import { supabase } from './supabaseClient.js'

// id=433 §二.
export const MAX_TAGS_PER_NOTE = 8
export const MAX_TAG_LENGTH = 30

const ASCII_RE = /^[\x00-\x7F]+$/

// Judgment call (id=433 §二 leaves this to CC, but requires one consistent
// rule): internal whitespace is collapsed to a single space and kept as-is,
// never converted to hyphens.
function collapseSpaces(s) {
  return s.replace(/\s+/g, ' ').trim()
}

export function stripHash(raw) {
  return raw.replace(/^#+/, '')
}

// Storage form (id=433 §二): trim + strip leading # + collapse whitespace,
// then ascii is lowercased so `RLS`/`rls`/` RLS ` all store identically;
// CJK is kept exactly as typed.
export function normalizeTag(raw) {
  const stripped = collapseSpaces(stripHash(String(raw ?? '').trim()))
  if (!stripped) return ''
  return ASCII_RE.test(stripped) ? stripped.toLowerCase() : stripped
}

// Display form: ascii tags show with a capitalized first letter; CJK is
// already the canonical form, so it round-trips unchanged.
export function displayTag(stored) {
  if (!stored) return ''
  if (ASCII_RE.test(stored)) return stored.charAt(0).toUpperCase() + stored.slice(1)
  return stored
}

export function tagsEqual(a, b) {
  return normalizeTag(a) === normalizeTag(b)
}

// Validates + normalizes one new tag against the note's current tag list
// (id=433 §一.2 duplicate hint, §二 length/count limits). Returns the
// normalized (storage-form) tag on success.
export function validateNewTag(raw, existingTags) {
  const normalized = normalizeTag(raw)
  if (!normalized) return { ok: false, reason: 'empty' }
  if (normalized.length > MAX_TAG_LENGTH) return { ok: false, reason: 'too_long' }
  if (existingTags.some((t) => normalizeTag(t) === normalized)) return { ok: false, reason: 'duplicate' }
  if (existingTags.length >= MAX_TAGS_PER_NOTE) return { ok: false, reason: 'too_many' }
  return { ok: true, tag: normalized }
}

const TABLE = 'work_whiteboard'

// Aggregates tag -> {count, lastUsed} across the current user's own
// non-deleted notes for autocomplete + 常用標籤 (id=433 §三/§五). RLS scopes
// the select to rows the caller owns, so no extra filtering is needed here.
export async function getTagStats() {
  const { data, error } = await supabase.from(TABLE).select('tags, created_at').is('deleted_at', null)
  if (error) throw error
  const stats = new Map()
  for (const row of data) {
    if (!Array.isArray(row.tags)) continue
    for (const rawTag of row.tags) {
      // Re-normalize on read too: notes written before this feature (via the
      // old comma-text field) may have inconsistent casing already stored,
      // and those variants must still merge into one stat entry (id=433 §二).
      const tag = normalizeTag(rawTag)
      if (!tag) continue
      const existing = stats.get(tag)
      if (existing) {
        existing.count += 1
        if (row.created_at > existing.lastUsed) existing.lastUsed = row.created_at
      } else {
        stats.set(tag, { tag, count: 1, lastUsed: row.created_at })
      }
    }
  }
  return [...stats.values()]
}

// Autocomplete ranking (id=433 §一.3): ① most recently used ② highest count
// ③ prefix match ahead of fuzzy (substring) match.
export function rankTagSuggestions(stats, query) {
  const q = normalizeTag(query)
  return stats
    .filter((s) => !q || s.tag.includes(q))
    .sort((a, b) => {
      if (a.lastUsed !== b.lastUsed) return a.lastUsed > b.lastUsed ? -1 : 1
      if (a.count !== b.count) return b.count - a.count
      const aPrefix = a.tag.startsWith(q) ? 0 : 1
      const bPrefix = b.tag.startsWith(q) ? 0 : 1
      return aPrefix - bPrefix
    })
}
