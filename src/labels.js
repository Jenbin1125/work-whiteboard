// Display-layer translation only (id=432 §三) — the DB always keeps the
// canonical code; nothing here changes what gets read or written.
export const STATUS_LABELS = {
  raw: '待整理',
  triaged: '已看過',
  archived: '已封存',
  extracted: '已萃取',
}

export const PROJECT_LABELS = {
  medexam: '醫學考試',
  surgical_pref_card: '手術偏好卡',
  line_sdm: 'LINE SDM',
  other: '其他',
}

export const SOURCE_LABELS = {
  agent_chat: 'Agent 對話',
  external_document: '外部文件',
  literature: '文獻',
  human_idea: '人類發想',
  other: '其他',
}

// recipient/From values stay as their canonical strings (id=429 §2.3 already
// decided this — no separate display-name table for this POC), just grouped
// for easier scanning in dropdowns.
export const RECIPIENT_GROUPS = [
  { label: 'Human', values: ['Human-Jenbin'] },
  {
    label: 'Claude agents',
    values: [
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
    ],
  },
  { label: 'GPT / Codex / CC', values: ['GPT', 'Codex', 'Orchestrator-Assistant', 'CC'] },
]

export function statusLabel(code) {
  return STATUS_LABELS[code] || code
}
export function projectLabel(code) {
  return PROJECT_LABELS[code] || code
}
export function sourceLabel(code) {
  return SOURCE_LABELS[code] || code
}
// This POC has exactly one owner (RLS scopes every row to its creator), so a
// NULL created_by_label always means "you" — no ambiguity to resolve.
export function fromLabel(label) {
  return label || '你'
}
