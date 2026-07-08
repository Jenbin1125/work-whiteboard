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

// Pure display-layer glossary (id=434 §一) — storage form is untouched, this
// only fixes acronyms that read oddly under plain capitalize-first-letter
// (rls -> Rls). Extend as new abbreviations show up; never needs a migration.
const TAG_DISPLAY_NAMES = {
  rls: 'RLS',
  uiux: 'UI/UX',
  nec: 'NEC',
  vur: 'VUR',
  api: 'API',
  sql: 'SQL',
  pdf: 'PDF',
  jwt: 'JWT',
}

// Display form: glossary hit wins; otherwise ascii tags show with a
// capitalized first letter; CJK is already the canonical form, so it
// round-trips unchanged.
export function displayTag(stored) {
  if (!stored) return ''
  if (TAG_DISPLAY_NAMES[stored]) return TAG_DISPLAY_NAMES[stored]
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

async function fetchTagStats() {
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

// Shared cache (id=434 §七) — every tag chip editor / common-tags block on
// the page used to call getTagStats() independently. One TTL'd cache + a
// shared in-flight promise means simultaneous callers (e.g. Compose + filter
// popover mounting together) trigger exactly one query, not one each.
const CACHE_TTL_MS = 3 * 60 * 1000
let cachedStats = null
let cachedAt = 0
let inFlight = null

// Aggregates tag -> {count, lastUsed} across the current user's own
// non-deleted notes for autocomplete + 常用標籤 (id=433 §三/§五). RLS scopes
// the select to rows the caller owns, so no extra filtering is needed here.
export async function getTagStats() {
  if (cachedStats && Date.now() - cachedAt < CACHE_TTL_MS) return cachedStats
  if (inFlight) return inFlight
  inFlight = fetchTagStats()
    .then((stats) => {
      cachedStats = stats
      cachedAt = Date.now()
      inFlight = null
      return stats
    })
    .catch((err) => {
      inFlight = null
      throw err
    })
  return inFlight
}

// Called after any write that touches `tags` (create/update) so the next
// read reflects it immediately instead of waiting out the TTL.
export function invalidateTagStats() {
  cachedStats = null
  cachedAt = 0
  inFlight = null
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
