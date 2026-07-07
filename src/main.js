import { onAuthChange, signInWithGoogle, signOut } from './auth.js'
import {
  PROJECT_KEYS,
  SOURCE_TYPES,
  STATUSES,
  RECIPIENTS,
  UNSET_RECIPIENT,
  listNotes,
  createNote,
  updateNote,
  updateStatus,
  softDelete,
  restoreNote,
  hardDeleteNote,
  getNoteById,
} from './whiteboard.js'
import { loadDraft, saveDraft, clearDraft } from './draft.js'
import { getNoteIdFromHash, navigateToNote, clearNoteHash, onHashChange } from './router.js'
import { buildReferenceText, buildAttachmentReferenceText, copyToClipboard } from './copyReference.js'
import { statusLabel, projectLabel, sourceLabel, fromLabel, RECIPIENT_GROUPS } from './labels.js'
import { friendlyErrorMessage } from './friendlyError.js'
import { normalizeTag, displayTag, validateNewTag, getTagStats, rankTagSuggestions } from './tags.js'
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_BYTES,
  MAX_FILES_PER_NOTE,
  MAX_TOTAL_BYTES_PER_NOTE,
  IMAGE_MIME_TYPES,
  TEXT_MIME_TYPES,
  resolveMimeType,
  listAttachments,
  uploadAttachment,
  retryUpload,
  softDeleteAttachment,
  getSignedUrl,
} from './attachments.js'

const app = document.getElementById('app')

// --- tiny DOM helpers -------------------------------------------------
// Every text value below goes through textContent (never innerHTML), so
// pasted content can never execute as markup/script regardless of what a
// user pastes into the note box.
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v)
  }
  for (const child of children) node.appendChild(child)
  return node
}

function option(value, label) {
  return el('option', { value, text: label })
}

function debounce(fn, ms) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

let currentSession = null
let filters = { projectKey: '', status: '', source: '', tags: [], trash: false, from: '', to: '', search: '' }
let activeNoteId = null
let detailPanelEl = null
let listMountEl = null
let openMenuCloser = null
let copyInFlight = false
// Set by renderFilters() each time the board renders; lets row-level tag
// chips (id=433 §三.2) push a tag into the filter state + popover editor
// without threading the filter closures through renderRow's call chain.
let addTagFilterFn = null
// Which rows currently have their Payload accordion open. Keyed by note id
// so it survives refreshList() rebuilding the DOM (e.g. after a status
// change or delete on that same row) instead of silently re-collapsing.
let expandedIds = new Set()
let toastTimeoutId = null
let lastFocusedBeforeDetail = null

function render() {
  app.replaceChildren()
  detailPanelEl = null
  listMountEl = null
  if (currentSession) {
    app.appendChild(renderBoard())
    syncDetailFromHash()
  } else {
    app.appendChild(renderLogin())
  }
}

function renderLogin() {
  return el('div', { class: 'login' }, [
    el('h1', { text: 'Work Whiteboard' }),
    el('p', { text: '請使用 Google 帳號登入。' }),
    el('button', { text: '以 Google 登入', onclick: () => signInWithGoogle() }),
  ])
}

function renderBoard() {
  const container = el('div', { class: 'board' })

  const header = el('header', {}, [
    el('h1', { text: 'Work Whiteboard' }),
    el('div', { class: 'who' }, [
      el('span', { text: currentSession.user.email || '' }),
      el('button', { text: '登出', onclick: () => signOut() }),
    ]),
  ])
  container.appendChild(header)

  const listMount = el('div', { class: 'list-mount' })
  listMountEl = listMount

  const isMobile = window.matchMedia('(max-width: 900px)').matches
  const composeDetails = renderNoteForm({ startOpen: !isMobile })
  const listCol = el('div', { class: 'list-col' }, [renderFilters(listMount), listMount])
  const formCol = el('div', { class: 'form-col' }, [composeDetails])

  container.appendChild(el('div', { class: 'board-grid' }, [formCol, listCol]))

  detailPanelEl = el('aside', { class: 'detail-panel hidden', 'aria-label': '便利貼詳情' })
  container.appendChild(detailPanelEl)

  refreshList(listMount).then((notes) => {
    // Mobile: an empty board still opens the compose form so first-time use
    // isn't a mystery; once notes exist it stays collapsed to keep the inbox
    // above the fold (id=432 §四).
    if (isMobile && notes && notes.length === 0) composeDetails.open = true
  })

  return container
}

function renderNoteForm({ startOpen }) {
  const contentInput = el('textarea', { placeholder: 'Payload（純文字）', rows: '10' })
  const titleInput = el('input', { type: 'text', placeholder: 'Topic（選填）' })
  const fromSelect = el('select', {}, buildRecipientOptions())
  const projectSelect = el('select', {}, PROJECT_KEYS.map((k) => option(k, projectLabel(k))))
  const sourceSelect = el('select', {}, SOURCE_TYPES.map((k) => option(k, sourceLabel(k))))
  const toSelect = el('select', {}, [option('', '不指定'), ...buildRecipientOptions()])
  const tagEditor = buildTagChipEditor({ initialTags: [], onChange: () => persistDraft() })

  // Restore an in-progress draft (reload / navigate away and back).
  const draft = loadDraft()
  if (draft) {
    titleInput.value = draft.title || ''
    contentInput.value = draft.content || ''
    if (RECIPIENTS.includes(draft.createdByLabel)) fromSelect.value = draft.createdByLabel
    if (PROJECT_KEYS.includes(draft.projectKey)) projectSelect.value = draft.projectKey
    if (SOURCE_TYPES.includes(draft.sourceType)) sourceSelect.value = draft.sourceType
    if (RECIPIENTS.includes(draft.recipient)) toSelect.value = draft.recipient
    if (Array.isArray(draft.tags)) tagEditor.setTags(draft.tags)
  } else {
    fromSelect.value = 'Human-Jenbin'
  }

  const persistDraft = () => {
    saveDraft({
      title: titleInput.value,
      content: contentInput.value,
      createdByLabel: fromSelect.value,
      projectKey: projectSelect.value,
      sourceType: sourceSelect.value,
      recipient: toSelect.value,
      tags: tagEditor.getTags(),
    })
  }
  ;[titleInput, contentInput].forEach((input) => input.addEventListener('input', persistDraft))
  ;[fromSelect, projectSelect, sourceSelect, toSelect].forEach((sel) => sel.addEventListener('change', persistDraft))

  const phiNote = el('p', { class: 'phi-inline-note', text: '⚠️ 上傳/送出即表示已確認不含病人可辨識資訊(PHI)、密碼、API key/token，或未經授權的受版權內容。' })
  const status = el('p', { class: 'form-status' })
  const submitBtn = el('button', { type: 'submit', text: '新增' })

  const doSubmit = async () => {
    status.textContent = ''
    const content = contentInput.value
    if (!content || !content.trim()) {
      status.textContent = '內容不可為空。'
      return
    }
    const tags = tagEditor.getTags()

    submitBtn.disabled = true
    try {
      const newNote = await createNote({
        title: titleInput.value.trim(),
        content,
        projectKey: projectSelect.value,
        sourceType: sourceSelect.value,
        recipient: toSelect.value,
        createdByLabel: fromSelect.value,
        tags,
      })
      titleInput.value = ''
      contentInput.value = ''
      toSelect.value = ''
      tagEditor.setTags([])
      fromSelect.value = 'Human-Jenbin'
      clearDraft()
      if (listMountEl) refreshList(listMountEl)
      showToast('已建立便利貼', {
        actionLabel: '開啟詳情',
        onAction: () => navigateToNote(newNote.id),
        duration: 4000,
      })
    } catch (err) {
      status.textContent = friendlyErrorMessage(err)
    } finally {
      submitBtn.disabled = false
    }
  }

  const form = el('form', {
    class: 'note-form',
    onsubmit: (e) => {
      e.preventDefault()
      doSubmit()
    },
    onkeydown: (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        doSubmit()
      }
    },
  })

  const fromField = el('label', { class: 'field-label' }, [el('span', { text: 'From' }), fromSelect])
  const moreFields = el('div', { class: 'row' }, [
    labeledField('專案', projectSelect),
    labeledField('來源', sourceSelect),
    labeledField('To', toSelect),
    tagField(tagEditor),
  ])
  const moreDetails = el('details', { class: 'compose-more' }, [el('summary', { text: '更多分類' }), moreFields])

  form.appendChild(contentInput)
  form.appendChild(titleInput)
  form.appendChild(fromField)
  form.appendChild(moreDetails)
  form.appendChild(el('div', { class: 'compose-submit-row' }, [submitBtn, phiNote]))
  form.appendChild(status)

  // Native <details> gives a free, accessible collapse/expand on narrow
  // screens without extra JS. <summary> must be a direct child of <details>
  // or the browser ignores it and renders its own default toggle instead.
  const details = el('details', { class: 'compose-details' }, [el('summary', { text: '貼上筆記' }), form])
  if (startOpen) details.open = true

  details.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') details.open = false
  })

  return details
}

function labeledField(labelText, control) {
  return el('label', { class: 'field-label field-label-compact' }, [el('span', { text: labelText }), control])
}

function buildRecipientOptions() {
  const opts = []
  for (const group of RECIPIENT_GROUPS) {
    const optGroup = el('optgroup', { label: group.label })
    group.values.forEach((v) => optGroup.appendChild(option(v, v)))
    opts.push(optGroup)
  }
  return opts
}

// --- tag chip editor (id=433 §一/§二/§六): shared by Compose, the detail
// edit form, and the filter popover's tag multi-select. -------------------
function buildTagChipEditor({ initialTags = [], onChange } = {}) {
  let tags = [...initialTags]
  let statsCache = null
  let statsLoaded = false

  const row = el('div', { class: 'tag-chips-row' })
  const input = el('input', { type: 'text', class: 'tag-chip-input', placeholder: '輸入標籤…' })
  row.appendChild(input)
  const dupHint = el('span', { class: 'tag-dup-hint hidden', text: '已經加入這個標籤' })
  const limitHint = el('span', { class: 'tag-dup-hint hidden' })
  const suggestionsEl = el('ul', { class: 'tag-suggestions hidden' })
  const recentEl = el('div', { class: 'tag-recent hidden' })

  function loadStats() {
    if (statsLoaded) return Promise.resolve(statsCache)
    return getTagStats()
      .then((s) => {
        statsCache = s
        statsLoaded = true
        return s
      })
      .catch(() => {
        statsCache = []
        statsLoaded = true
        return []
      })
  }

  function renderChips() {
    row.querySelectorAll('.tag-chip').forEach((n) => n.remove())
    for (const t of tags) {
      const chip = el('span', { class: 'tag-chip' }, [
        el('span', { text: displayTag(t) }),
        el('button', {
          type: 'button',
          'aria-label': '移除標籤 ' + displayTag(t),
          text: '×',
          onclick: (e) => {
            e.stopPropagation()
            tags = tags.filter((x) => x !== t)
            renderChips()
            onChange && onChange([...tags])
          },
        }),
      ])
      row.insertBefore(chip, input)
    }
  }

  function flashHint(el2, text) {
    el2.textContent = text
    el2.classList.remove('hidden')
    setTimeout(() => el2.classList.add('hidden'), 1800)
  }

  function tryAdd(raw) {
    const result = validateNewTag(raw, tags)
    if (!result.ok) {
      if (result.reason === 'duplicate') flashHint(dupHint, '已經加入這個標籤')
      else if (result.reason === 'too_many') flashHint(limitHint, '每則便利貼最多 8 個標籤')
      else if (result.reason === 'too_long') flashHint(limitHint, '單一標籤最多 30 字')
      return false
    }
    tags = [...tags, result.tag]
    renderChips()
    onChange && onChange([...tags])
    renderSuggestions()
    return true
  }

  function renderSuggestions() {
    const q = input.value.trim()
    if (!q || !statsLoaded) {
      suggestionsEl.classList.add('hidden')
      suggestionsEl.replaceChildren()
      return
    }
    const ranked = rankTagSuggestions(statsCache, q).filter((s) => !tags.includes(s.tag))
    const items = ranked.slice(0, 8).map((s) =>
      el('li', {}, [
        el('button', {
          type: 'button',
          class: 'tag-suggestion-btn',
          onclick: (e) => {
            e.stopPropagation()
            tryAdd(s.tag)
            input.value = ''
            suggestionsEl.classList.add('hidden')
            input.focus()
          },
        }, [el('span', { text: displayTag(s.tag) }), el('span', { class: 'tag-suggestion-count', text: s.count + ' 則' })]),
      ])
    )
    const normalizedQ = normalizeTag(q)
    if (normalizedQ && !ranked.some((s) => s.tag === normalizedQ) && !tags.includes(normalizedQ)) {
      items.push(
        el('li', {}, [
          el('button', {
            type: 'button',
            class: 'tag-suggestion-btn tag-suggestion-new',
            text: `建立新標籤「${q.trim()}」`,
            onclick: (e) => {
              e.stopPropagation()
              tryAdd(q)
              input.value = ''
              suggestionsEl.classList.add('hidden')
              input.focus()
            },
          }),
        ])
      )
    }
    suggestionsEl.replaceChildren(...items)
    suggestionsEl.classList.toggle('hidden', items.length === 0)
  }

  function renderRecent() {
    loadStats().then((stats) => {
      const recent = [...stats].sort((a, b) => (a.lastUsed > b.lastUsed ? -1 : 1)).slice(0, 5)
      if (!recent.length) {
        recentEl.classList.add('hidden')
        return
      }
      recentEl.replaceChildren(
        el('span', { class: 'tag-recent-label', text: '最近使用：' }),
        ...recent.map((s) =>
          el('button', {
            type: 'button',
            class: 'tag-recent-btn',
            text: displayTag(s.tag),
            onclick: (e) => {
              e.stopPropagation()
              tryAdd(s.tag)
            },
          })
        )
      )
      recentEl.classList.remove('hidden')
    })
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      const v = input.value.replace(/,$/, '')
      if (v.trim()) tryAdd(v)
      input.value = ''
      renderSuggestions()
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      tags = tags.slice(0, -1)
      renderChips()
      onChange && onChange([...tags])
    }
  })
  input.addEventListener('input', renderSuggestions)
  input.addEventListener('focus', () => {
    loadStats().then(renderSuggestions)
  })
  input.addEventListener('click', (e) => e.stopPropagation())

  renderChips()
  renderRecent()

  const wrap = el('div', { class: 'tag-chip-editor' }, [row, dupHint, limitHint, suggestionsEl, recentEl])

  return {
    element: wrap,
    getTags: () => [...tags],
    setTags: (next) => {
      tags = [...next]
      renderChips()
    },
  }
}

// id=433 §〇/§七: the same mental-model + interaction hint copy, verbatim,
// wherever the tag editor appears in an editable (non-filter) context.
function tagField(tagEditor, { label = '標籤（選填）' } = {}) {
  return el('div', { class: 'field-label field-label-compact tag-field' }, [
    el('span', { text: label }),
    tagEditor.element,
    el('p', { class: 'field-hint', text: '標籤用來跨專案尋找相同主題，例如 NEC、RLS、Storage；不代表收件人或處理狀態。' }),
    el('p', { class: 'field-hint', text: '用來跨專案尋找主題。輸入後按 Enter，例如 NEC、Level3、Storage；不需輸入 #。' }),
  ])
}

// 常用標籤 quick-access block (id=433 §五), used inside the filter popover.
function buildCommonTagsBlock({ onSelect }) {
  const listEl = el('ul', { class: 'common-tags-list' })
  const wrap = el('div', { class: 'common-tags-block' }, [el('div', { class: 'common-tags-title', text: '常用標籤' }), listEl])
  let expanded = false
  let stats = []

  function draw() {
    const sorted = [...stats].sort((a, b) => b.count - a.count)
    const shown = sorted.slice(0, expanded ? 20 : 5)
    if (!shown.length) {
      listEl.replaceChildren(el('li', { class: 'common-tags-empty', text: '尚無標籤資料' }))
      return
    }
    const items = shown.map((s) =>
      el('li', {}, [
        el(
          'button',
          {
            type: 'button',
            class: 'common-tag-btn',
            onclick: (e) => {
              e.stopPropagation()
              onSelect(s.tag)
            },
          },
          [el('span', { text: displayTag(s.tag) }), el('span', { class: 'common-tag-count', text: String(s.count) })]
        ),
      ])
    )
    if (sorted.length > 5) {
      items.push(
        el('li', {}, [
          el('button', {
            type: 'button',
            class: 'common-tags-toggle',
            text: expanded ? '收合' : '查看全部',
            onclick: (e) => {
              e.stopPropagation()
              expanded = !expanded
              draw()
            },
          }),
        ])
      )
    }
    listEl.replaceChildren(...items)
  }

  async function load() {
    listEl.replaceChildren(el('li', { text: '載入中…' }))
    try {
      stats = await getTagStats()
      draw()
    } catch (err) {
      listEl.replaceChildren(el('li', { class: 'error', text: friendlyErrorMessage(err) }))
    }
  }

  load()
  return { element: wrap, reload: load }
}

// id=433 §四.3: exact empty-result copy for a tag-filtered list.
function tagsEmptyMessage(tags) {
  if (!tags || !tags.length) return null
  const names = tags.map(displayTag)
  if (names.length === 1) return `沒有包含「${names[0]}」的便利貼。`
  return `沒有同時包含「${names.join('」與「')}」的便利貼。移除一個標籤試試。`
}

// --- filters: search bar + popover + active-filter chips (id=432 §六) ------
function renderFilters(listMount) {
  const searchInput = el('input', { type: 'text', class: 'wb-search', placeholder: '搜尋標題或內容…' })
  const filterToggle = el('button', { type: 'button', class: 'filter-toggle', text: '篩選' })
  const trashToggle = el('button', {
    type: 'button',
    class: 'trash-toggle',
    text: filters.trash ? '返回白板' : '垃圾桶',
  })

  const projectSelect = el('select', {}, [option('', '全部專案'), ...PROJECT_KEYS.map((k) => option(k, projectLabel(k)))])
  const statusSelect = el('select', {}, [option('', '全部狀態'), ...STATUSES.map((k) => option(k, statusLabel(k)))])
  const sourceSelect = el('select', {}, [option('', '全部來源'), ...SOURCE_TYPES.map((k) => option(k, sourceLabel(k)))])
  const fromInput = el('input', { type: 'text', placeholder: 'From 篩選' })
  const toSelect = el('select', {}, [option('', '全部收件人'), option(UNSET_RECIPIENT, '未指名'), ...buildRecipientOptions()])

  const tagFilterEditor = buildTagChipEditor({
    initialTags: [],
    onChange: (tags) => {
      filters = { ...filters, tags }
      renderChips()
      refreshList(listMount)
    },
  })
  const commonTagsBlock = buildCommonTagsBlock({ onSelect: (tag) => addTagToFilter(tag) })

  const popover = el('div', { class: 'filter-popover hidden' }, [
    labeledField('專案', projectSelect),
    labeledField('狀態', statusSelect),
    labeledField('來源', sourceSelect),
    labeledField('From', fromInput),
    labeledField('To', toSelect),
    labeledField('標籤', tagFilterEditor.element),
    commonTagsBlock.element,
    el('button', { type: 'button', class: 'clear-filters-btn', text: '清除全部', onclick: clearAllFilters }),
  ])

  const chipsRow = el('div', { class: 'filter-chips' })

  filterToggle.addEventListener('click', () => {
    const wasHidden = popover.classList.contains('hidden')
    popover.classList.toggle('hidden')
    if (wasHidden) commonTagsBlock.reload()
  })

  function apply() {
    filters = {
      ...filters,
      projectKey: projectSelect.value,
      status: statusSelect.value,
      source: sourceSelect.value,
      from: fromInput.value.trim(),
      to: toSelect.value,
      search: searchInput.value.trim(),
    }
    renderChips()
    refreshList(listMount)
  }

  function clearAllFilters() {
    searchInput.value = ''
    projectSelect.value = ''
    statusSelect.value = ''
    sourceSelect.value = ''
    fromInput.value = ''
    toSelect.value = ''
    tagFilterEditor.setTags([])
    filters = { ...filters, tags: [] }
    apply()
  }

  function clearOne(key, control, value) {
    control.value = value
    apply()
  }

  // Shared by the popover's own chip editor and row-level tag-chip clicks
  // (id=433 §三.2) — both must keep filters.tags, the editor's own chips,
  // and the active-filter chips row in sync.
  function addTagToFilter(tag) {
    if (filters.tags.includes(tag)) return
    const next = [...filters.tags, tag]
    filters = { ...filters, tags: next }
    tagFilterEditor.setTags(next)
    renderChips()
    refreshList(listMount)
  }

  function removeTagFromFilter(tag) {
    const next = filters.tags.filter((t) => t !== tag)
    filters = { ...filters, tags: next }
    tagFilterEditor.setTags(next)
    renderChips()
    refreshList(listMount)
  }

  addTagFilterFn = addTagToFilter

  function renderChips() {
    const chips = []
    if (filters.search) chips.push(['搜尋: ' + filters.search, () => clearOne('search', searchInput, '')])
    if (filters.projectKey) chips.push(['專案: ' + projectLabel(filters.projectKey), () => clearOne('projectKey', projectSelect, '')])
    if (filters.status) chips.push(['狀態: ' + statusLabel(filters.status), () => clearOne('status', statusSelect, '')])
    if (filters.source) chips.push(['來源: ' + sourceLabel(filters.source), () => clearOne('source', sourceSelect, '')])
    if (filters.from) chips.push(['From: ' + filters.from, () => clearOne('from', fromInput, '')])
    if (filters.to) chips.push(['To: ' + (filters.to === UNSET_RECIPIENT ? '未指名' : filters.to), () => clearOne('to', toSelect, '')])
    filters.tags.forEach((t) => chips.push(['標籤: ' + displayTag(t), () => removeTagFromFilter(t)]))

    chipsRow.replaceChildren(
      ...chips.map(([label, onClear]) =>
        el('span', { class: 'filter-chip' }, [
          el('span', { text: label }),
          el('button', { type: 'button', 'aria-label': '移除篩選', text: '×', onclick: onClear }),
        ])
      )
    )
  }

  const debouncedApply = debounce(apply, 300)
  searchInput.addEventListener('input', debouncedApply)
  projectSelect.addEventListener('change', apply)
  statusSelect.addEventListener('change', apply)
  sourceSelect.addEventListener('change', apply)
  const debouncedFrom = debounce(apply, 300)
  fromInput.addEventListener('input', debouncedFrom)
  toSelect.addEventListener('change', apply)

  trashToggle.addEventListener('click', () => {
    filters = { ...filters, trash: !filters.trash }
    trashToggle.textContent = filters.trash ? '返回白板' : '垃圾桶'
    refreshList(listMount)
  })

  const bar = el('div', { class: 'filter-bar' }, [searchInput, filterToggle, trashToggle])
  return el('div', { class: 'filters' }, [bar, popover, chipsRow])
}

function hasActiveFilters() {
  return !!(filters.projectKey || filters.status || filters.source || filters.from || filters.to || filters.search || (filters.tags && filters.tags.length))
}

async function refreshList(mount) {
  mount.replaceChildren(el('p', { text: '載入中…' }))
  try {
    const notes = await listNotes({
      projectKey: filters.projectKey,
      status: filters.status,
      sourceType: filters.source,
      tags: filters.tags,
      trash: filters.trash,
      fromLabel: filters.from,
      to: filters.to,
      search: filters.search,
    })
    mount.replaceChildren(renderList(notes, mount))
    applyHighlight()
    return notes
  } catch (err) {
    mount.replaceChildren(el('p', { class: 'error', text: friendlyErrorMessage(err) }))
    return []
  }
}

function renderList(notes, mount) {
  if (!notes.length) {
    const message = filters.trash
      ? '垃圾桶是空的。'
      : filters.tags && filters.tags.length
        ? tagsEmptyMessage(filters.tags)
        : hasActiveFilters()
          ? '目前篩選無結果。'
          : '白板尚無資料，貼上第一則筆記開始吧。'
    return el('p', { class: 'empty-state', text: message })
  }

  const items = notes.map((note) => renderRow(note, mount))
  return el('ul', { class: 'wb-list' }, items)
}

// id=429: horizontal inbox row. Collapsed = From/To badges + Topic + time
// only; clicking anywhere on the row bar (badges, topic, or empty space)
// expands the full Payload below — same accordion element also carries the
// status/delete actions that used to sit directly on the card.
// id=433 §三: up to 3 clickable tag chips shown even on the collapsed row;
// clicking applies a filter and must never toggle the row's own expand state.
function buildRowTagChips(note) {
  const tags = Array.isArray(note.tags) ? note.tags : []
  if (!tags.length) return el('div')
  const shown = tags.slice(0, 3)
  const overflow = tags.length - shown.length
  const children = shown.map((t) =>
    el('button', {
      type: 'button',
      class: 'row-tag-chip',
      text: '#' + displayTag(t),
      onclick: (e) => {
        e.stopPropagation()
        if (addTagFilterFn) addTagFilterFn(t)
      },
    })
  )
  if (overflow > 0) children.push(el('span', { class: 'row-tag-overflow', text: '+' + overflow }))
  return el('div', { class: 'wb-row-tags' }, children)
}

function renderRow(note, mount) {
  const isTrashed = !!note.deleted_at
  const actionsEl = isTrashed ? buildTrashActions(note, mount) : buildNormalActions(note, mount)

  // textContent only — pasted content is always rendered as plain text, never innerHTML.
  const payloadEl = el('pre', { class: 'wb-payload', text: note.content })

  const isExpanded = expandedIds.has(note.id)
  // Visibility follows id=430 §九's derivation exactly: a soft-deleted note
  // never renders its attachments section — no separate logic needed,
  // restoring the note just means this stops being true.
  const attachments = isTrashed ? null : buildAttachmentsSection(note)
  const expandChildren = [
    payloadEl,
    el('div', { class: 'note-meta' }, [
      el('span', { class: 'tag-project', text: projectLabel(note.project_key) }),
      el('span', { text: ' 來源: ' + sourceLabel(note.source_type) + ' ・ ' + formatTimeMeta(note) }),
    ]),
    actionsEl,
  ]
  if (attachments) expandChildren.push(attachments.element)
  const expandSection = el('div', { class: isExpanded ? 'wb-row-expand' : 'wb-row-expand hidden' }, expandChildren)

  const fromBadge = el('span', { class: 'badge badge-from' }, [
    el('span', { 'aria-hidden': 'true', text: '👤' }),
    el('span', { text: fromLabel(note.created_by_label) }),
  ])

  const toBadge = note.recipient
    ? el('span', { class: 'badge badge-to-set' }, [el('span', { 'aria-hidden': 'true', text: '👤' }), el('span', { text: note.recipient })])
    : el('span', { class: 'badge-to-unset', text: '未指名' })

  const topicText = note.title && note.title.trim() ? note.title : (note.content || '').split('\n')[0].trim() || '(無內容)'
  const topicEl = el('span', { class: 'wb-topic', text: topicText })

  const timeEl = el('span', { class: 'wb-time', text: new Date(note.created_at).toLocaleString() })

  const menu = buildCardMenu(note)

  const rowMain = el(
    'div',
    { class: 'wb-row-main', role: 'button', tabindex: '0', 'aria-expanded': String(isExpanded) },
    [fromBadge, toBadge, topicEl, timeEl, menu]
  )

  const toggle = () => {
    const nowHidden = expandSection.classList.toggle('hidden')
    rowMain.setAttribute('aria-expanded', String(!nowHidden))
    if (nowHidden) {
      expandedIds.delete(note.id)
    } else {
      expandedIds.add(note.id)
      if (attachments) attachments.load()
    }
  }
  rowMain.addEventListener('click', toggle)
  rowMain.addEventListener('keydown', (e) => {
    if (e.target !== rowMain) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  })

  // Attachments are queried lazily, only once actually visible (id=431 §一:
  // never for every row up front — that would slow the whole list down).
  // If this row survived a refresh already expanded, load immediately.
  if (isExpanded && attachments) attachments.load()

  return el('li', { class: 'wb-row', 'data-note-id': String(note.id) }, [rowMain, buildRowTagChips(note), expandSection])
}

function formatTimeMeta(note) {
  const created = new Date(note.created_at)
  if (note.updated_at && note.updated_at !== note.created_at) {
    return '更新於 ' + new Date(note.updated_at).toLocaleString()
  }
  return created.toLocaleString()
}

function buildNormalActions(note, mount) {
  const statusSelect = el('select', {}, STATUSES.map((s) => option(s, statusLabel(s))))
  statusSelect.value = STATUSES.includes(note.status) ? note.status : STATUSES[0]
  statusSelect.addEventListener('change', async (e) => {
    e.stopPropagation()
    try {
      await updateStatus(note.id, statusSelect.value)
      refreshList(mount)
      if (activeNoteId === note.id) syncDetailFromHash()
    } catch (err) {
      showToast(friendlyErrorMessage(err))
    }
  })
  statusSelect.addEventListener('click', (e) => e.stopPropagation())

  const trashBtn = el('button', {
    class: 'delete-btn',
    type: 'button',
    text: '移到垃圾桶',
    onclick: async (e) => {
      e.stopPropagation()
      try {
        await softDelete(note.id)
        expandedIds.delete(note.id)
        refreshList(mount)
        if (activeNoteId === note.id) syncDetailFromHash()
        showToast('已移到垃圾桶', {
          actionLabel: '復原',
          onAction: async () => {
            try {
              await restoreNote(note.id)
              refreshList(mount)
            } catch (err) {
              showToast(friendlyErrorMessage(err))
            }
          },
          duration: 5000,
        })
      } catch (err) {
        showToast(friendlyErrorMessage(err))
      }
    },
  })

  return el('div', { class: 'note-actions' }, [statusSelect, trashBtn])
}

function buildTrashActions(note, mount) {
  const restoreBtn = el('button', {
    class: 'restore-btn',
    type: 'button',
    text: '復原',
    onclick: async (e) => {
      e.stopPropagation()
      try {
        await restoreNote(note.id)
        refreshList(mount)
        if (activeNoteId === note.id) syncDetailFromHash()
        showToast('已復原')
      } catch (err) {
        showToast(friendlyErrorMessage(err))
      }
    },
  })

  const permanentDeleteBtn = buildTwoStepButton({
    label: '永久刪除',
    confirmLabel: '確定永久刪除？',
    className: 'permanent-delete-btn',
    onConfirm: async () => {
      try {
        await hardDeleteNote(note.id)
        refreshList(mount)
        if (activeNoteId === note.id) clearNoteHash()
        showToast('已永久刪除')
      } catch (err) {
        showToast(friendlyErrorMessage(err))
      }
    },
  })

  return el('div', { class: 'note-actions' }, [restoreBtn, permanentDeleteBtn])
}

// Two-step in-place confirmation — used only for permanent delete (id=432
// §二: no native confirm() anywhere, but this one action keeps a deliberate
// second step). First click arms it for 3s; a second click within that
// window actually runs; otherwise it silently reverts.
function buildTwoStepButton({ label, confirmLabel, className, onConfirm }) {
  let armed = false
  let revertTimer = null
  const btn = el('button', { type: 'button', class: className, text: label })
  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    if (!armed) {
      armed = true
      btn.textContent = confirmLabel
      btn.classList.add('armed')
      revertTimer = setTimeout(() => {
        armed = false
        btn.textContent = label
        btn.classList.remove('armed')
      }, 3000)
      return
    }
    clearTimeout(revertTimer)
    armed = false
    btn.textContent = label
    btn.classList.remove('armed')
    await onConfirm()
  })
  return btn
}

// --- attachments (id=430/431): lives only inside the row's expanded state,
// never the collapsed row or the Compose Area — a note must exist first. ---
function buildAttachmentsSection(note) {
  const container = el('div', { class: 'wb-attachments-section' })
  const listEl = el('ul', { class: 'wb-attachment-list' })
  const counterEl = el('span', { class: 'wba-counter' })
  const errorEl = el('p', { class: 'wba-error hidden' })
  const fileInput = el('input', { type: 'file', class: 'hidden', accept: ALLOWED_MIME_TYPES.join(',') })
  const addBtn = el('button', { type: 'button', class: 'wba-add-btn', text: '+ 新增附件' })
  const phiNote = el('p', { class: 'wba-phi-note', text: '上傳即表示已確認不含病人可辨識資訊（PHI）' })

  let currentAttachments = []

  function updateCounter() {
    const totalBytes = currentAttachments.reduce((sum, a) => sum + (a.size_bytes || 0), 0)
    const totalMb = (totalBytes / (1024 * 1024)).toFixed(1)
    const capMb = (MAX_TOTAL_BYTES_PER_NOTE / (1024 * 1024)).toFixed(0)
    counterEl.textContent = `（${currentAttachments.length}/${MAX_FILES_PER_NOTE}・${totalMb}MB/${capMb}MB）`
  }

  function renderAttachmentList() {
    updateCounter()
    if (!currentAttachments.length) {
      listEl.replaceChildren(el('li', { class: 'wba-empty', text: '尚無附件' }))
      return
    }
    listEl.replaceChildren(...currentAttachments.map((a) => renderAttachmentRow(a, note.id, reload)))
  }

  async function reload() {
    listEl.replaceChildren(el('li', { text: '載入中…' }))
    try {
      currentAttachments = await listAttachments(note.id)
      renderAttachmentList()
    } catch (err) {
      listEl.replaceChildren(el('li', { class: 'error', text: friendlyErrorMessage(err) }))
    }
  }

  addBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    fileInput.click()
  })
  fileInput.addEventListener('click', (e) => e.stopPropagation())
  fileInput.addEventListener('change', async (e) => {
    e.stopPropagation()
    const file = fileInput.files[0]
    fileInput.value = ''
    if (!file) return
    errorEl.classList.add('hidden')

    // Local whitelist pre-check (id=431 §三) — reject before ever touching
    // Storage, with a clear inline message (no dialogs, matching the rest of
    // this app's interaction style).
    const mimeType = resolveMimeType(file)
    if (!mimeType) {
      errorEl.textContent = '這個檔案類型暫不支援上傳，目前支援圖片（PNG/JPEG/WEBP）、PDF 與純文字/Markdown'
      errorEl.classList.remove('hidden')
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      errorEl.textContent = '這個檔案超過 10MB 上限，請壓縮或分次上傳'
      errorEl.classList.remove('hidden')
      return
    }
    if (currentAttachments.length >= MAX_FILES_PER_NOTE) {
      errorEl.textContent = '這則便利貼最多可附加 5 個檔案'
      errorEl.classList.remove('hidden')
      return
    }
    const totalBytes = currentAttachments.reduce((sum, a) => sum + (a.size_bytes || 0), 0)
    if (totalBytes + file.size > MAX_TOTAL_BYTES_PER_NOTE) {
      errorEl.textContent = '附件總大小已達 25MB 上限'
      errorEl.classList.remove('hidden')
      return
    }

    try {
      await uploadAttachment({ noteId: note.id, ownerUid: currentSession.user.id, file, mimeType })
    } catch (err) {
      errorEl.textContent = friendlyErrorMessage(err)
      errorEl.classList.remove('hidden')
    }
    await reload()
  })

  container.appendChild(el('div', { class: 'wba-header' }, [el('span', { text: '📎 附件' }), counterEl]))
  container.appendChild(listEl)
  container.appendChild(errorEl)
  container.appendChild(el('div', { class: 'wba-upload-row' }, [addBtn, phiNote]))
  container.appendChild(fileInput)

  return { element: container, load: reload }
}

function triggerDownload(url, filename) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function buildRetryButton(att, onChanged) {
  const input = el('input', { type: 'file', class: 'hidden', accept: ALLOWED_MIME_TYPES.join(',') })
  input.addEventListener('click', (e) => e.stopPropagation())
  input.addEventListener('change', async (e) => {
    e.stopPropagation()
    const file = input.files[0]
    input.value = ''
    if (!file) return
    try {
      await retryUpload(att, file, resolveMimeType(file) || att.mime_type)
    } catch (err) {
      showToast(friendlyErrorMessage(err))
    }
    onChanged()
  })
  const btn = el('button', {
    class: 'wba-action-btn',
    type: 'button',
    text: '重試',
    onclick: (e) => {
      e.stopPropagation()
      input.click()
    },
  })
  return el('span', {}, [btn, input])
}

// TXT/MD: fetched fresh via a throwaway signed URL and rendered with
// textContent only — HTML-escaped, never parsed as Markdown or executed
// (id=431 §四).
function buildTextPreviewToggle(att) {
  const previewEl = el('pre', { class: 'wba-text-preview hidden' })
  let loaded = false
  const btn = el('button', { class: 'wba-action-btn', type: 'button', text: '檢視' })
  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    const isHidden = previewEl.classList.contains('hidden')
    if (!isHidden) {
      previewEl.classList.add('hidden')
      btn.textContent = '檢視'
      return
    }
    previewEl.classList.remove('hidden')
    btn.textContent = '收合'
    if (!loaded) {
      previewEl.textContent = '載入中…'
      try {
        const url = await getSignedUrl(att.object_path)
        const res = await fetch(url)
        previewEl.textContent = await res.text()
        loaded = true
      } catch (err) {
        previewEl.textContent = friendlyErrorMessage(err)
      }
    }
  })
  return { button: btn, preview: previewEl }
}

function renderAttachmentRow(att, noteId, onChanged) {
  const nameEl = el('span', { class: 'wba-name', text: att.original_name })

  const copyRefBtn = el('button', {
    class: 'wba-copy-btn',
    type: 'button',
    'aria-label': '複製附件引用',
    text: '🔗',
    onclick: async (e) => {
      e.stopPropagation()
      try {
        await copyToClipboard(buildAttachmentReferenceText(noteId, att.original_name))
        showToast('已複製附件引用')
      } catch (err) {
        showToast(friendlyErrorMessage(err))
      }
    },
  })

  const deleteBtn = el('button', {
    class: 'delete-btn',
    type: 'button',
    text: '🗑️',
    'aria-label': '刪除附件',
    onclick: async (e) => {
      e.stopPropagation()
      // Optimistic + no confirm dialog (id=431 §七, matches the rest of the
      // app's direct-action delete convention); reload restores state if the
      // request actually failed server-side.
      li.remove()
      try {
        await softDeleteAttachment(att.id)
      } catch (err) {
        showToast(friendlyErrorMessage(err))
        onChanged()
      }
    },
  })

  let icon
  let statusEl
  const actions = []
  let extraRow = null

  if (att.upload_status === 'ready') {
    if (IMAGE_MIME_TYPES.includes(att.mime_type)) {
      icon = el('span', { class: 'wba-thumb-placeholder', text: '🖼️' })
      getSignedUrl(att.object_path)
        .then((url) => {
          const img = el('img', { class: 'wba-thumb', src: url, alt: att.original_name })
          icon.replaceWith(img)
        })
        .catch(() => {
          icon.textContent = '⚠️'
        })
    } else if (att.mime_type === 'application/pdf') {
      icon = el('span', { 'aria-hidden': 'true', text: '📄' })
      actions.push(
        el('button', {
          class: 'wba-action-btn',
          type: 'button',
          text: '⬇️ 下載',
          onclick: async (e) => {
            e.stopPropagation()
            try {
              const url = await getSignedUrl(att.object_path)
              triggerDownload(url, att.original_name)
            } catch (err) {
              showToast(friendlyErrorMessage(err))
            }
          },
        })
      )
    } else if (TEXT_MIME_TYPES.includes(att.mime_type)) {
      icon = el('span', { 'aria-hidden': 'true', text: '📝' })
      const { button, preview } = buildTextPreviewToggle(att)
      actions.push(button)
      extraRow = preview
    } else {
      icon = el('span', { 'aria-hidden': 'true', text: '📎' })
    }
    statusEl = el('span', { class: 'wba-status wba-status-ready', text: 'ready' })
    actions.push(copyRefBtn, deleteBtn)
  } else if (att.upload_status === 'failed') {
    icon = el('span', { 'aria-hidden': 'true', text: '⚠️' })
    statusEl = el('span', { class: 'wba-status wba-status-failed', text: '上傳失敗' })
    actions.push(buildRetryButton(att, onChanged), deleteBtn)
  } else if (att.upload_status === 'delete_pending') {
    icon = el('span', { 'aria-hidden': 'true', text: '⏳' })
    statusEl = el('span', { class: 'wba-status wba-status-pending', text: '刪除處理中' })
  } else if (att.upload_status === 'uploading') {
    icon = el('span', { 'aria-hidden': 'true', text: '⏳' })
    statusEl = el('span', { class: 'wba-status', text: '上傳中…' })
  } else {
    icon = el('span', { 'aria-hidden': 'true', text: '⏳' })
    statusEl = el('span', { class: 'wba-status', text: '準備中' })
  }

  const mainLine = el('div', { class: 'wba-line' }, [icon, nameEl, statusEl, ...actions])
  const li = el('li', { class: 'wb-attachment' }, extraRow ? [mainLine, extraRow] : [mainLine])
  if (att.upload_status === 'delete_pending') li.classList.add('wba-delete-pending')
  return li
}

function buildCardMenu(note) {
  const wrap = el('div', { class: 'card-menu' })
  const popover = el('div', { class: 'card-menu-popover hidden' })

  const close = () => {
    popover.classList.add('hidden')
    if (openMenuCloser === close) openMenuCloser = null
  }

  const openDetailBtn = el('button', {
    class: 'card-menu-item',
    type: 'button',
    text: '開啟詳情',
    onclick: (e) => {
      e.stopPropagation()
      close()
      navigateToNote(note.id)
    },
  })
  popover.appendChild(openDetailBtn)
  popover.appendChild(buildCopyIconButton(note))

  const menuBtn = el('button', {
    class: 'card-menu-btn',
    type: 'button',
    'aria-label': '更多選項',
    text: '⋯',
    onclick: (e) => {
      e.stopPropagation()
      const wasHidden = popover.classList.contains('hidden')
      if (openMenuCloser) openMenuCloser()
      if (wasHidden) {
        popover.classList.remove('hidden')
        openMenuCloser = close
      }
    },
  })

  wrap.appendChild(menuBtn)
  wrap.appendChild(popover)
  return wrap
}

document.addEventListener('click', (e) => {
  if (openMenuCloser && !e.target.closest('.card-menu')) {
    openMenuCloser()
    openMenuCloser = null
  }
})

// id=427 §七: card-menu entry is icon-only. Feedback lives entirely in the
// tooltip text + aria-label swap (no toast) — deliberately not closing the
// popover on click, so the user actually sees the "已複製" state before it
// closes (via the existing click-outside handler).
function buildCopyIconButton(note) {
  const DEFAULT_LABEL = '複製白板引用'
  const DEFAULT_TOOLTIP = '複製引用'

  const tooltip = el('span', { class: 'copy-tooltip', 'aria-hidden': 'true', text: DEFAULT_TOOLTIP })
  const icon = el('span', { 'aria-hidden': 'true', text: '🔗' })
  const btn = el('button', { class: 'copy-icon-btn', type: 'button', 'aria-label': DEFAULT_LABEL })
  btn.appendChild(icon)
  btn.appendChild(tooltip)

  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    const ok = await performCopy(note, { toast: false })
    tooltip.textContent = ok ? '已複製' : '複製失敗'
    btn.setAttribute('aria-label', ok ? '已複製' : '複製失敗')
    tooltip.classList.add('force-visible')
    btn.classList.toggle('copied', ok)
    setTimeout(() => {
      tooltip.classList.remove('force-visible')
      tooltip.textContent = DEFAULT_TOOLTIP
      btn.setAttribute('aria-label', DEFAULT_LABEL)
      btn.classList.remove('copied')
    }, 1400)
  })

  return btn
}

// --- copy-reference (id=427 §二): id + short title + deep link, never the
// full note content, so a paste into a chat can't leak sensitive content. ---
// toast:false is used by the card-menu icon button (id=427 §七), which gives
// its own inline tooltip feedback instead of the shared toast.
async function performCopy(note, { toast = true } = {}) {
  if (copyInFlight) return false
  copyInFlight = true
  setTimeout(() => {
    copyInFlight = false
  }, 600)
  try {
    await copyToClipboard(buildReferenceText(note))
    if (toast) showToast('已複製白板引用')
    return true
  } catch (err) {
    if (toast) showToast(friendlyErrorMessage(err))
    return false
  }
}

// Toast (id=432 §十): the one shared, reused element — rapid actions can
// never stack up more than one. Optional action button supports the 5s
// trash-undo and the "開啟詳情" shortcut after creating a note.
function showToast(message, { actionLabel, onAction, duration = 1500 } = {}) {
  let toastEl = document.querySelector('.wb-toast')
  if (!toastEl) {
    toastEl = el('div', { class: 'wb-toast' })
    document.body.appendChild(toastEl)
  }
  const children = [el('span', { class: 'wb-toast-msg', text: message })]
  if (actionLabel && onAction) {
    children.push(
      el('button', {
        class: 'wb-toast-action',
        type: 'button',
        text: actionLabel,
        onclick: () => {
          onAction()
          toastEl.classList.remove('visible')
          if (toastTimeoutId) clearTimeout(toastTimeoutId)
        },
      })
    )
  }
  toastEl.replaceChildren(...children)
  toastEl.classList.add('visible')
  if (toastTimeoutId) clearTimeout(toastTimeoutId)
  toastTimeoutId = setTimeout(() => toastEl.classList.remove('visible'), duration)
}

// --- deep link (#/note/{id}) + detail panel (id=427 §一, redesigned id=432 §八) ---
// Independent of the inline row accordion above: a deep link still opens the
// side drawer / mobile full page, same as before this redesign.
function applyHighlight() {
  if (!listMountEl) return false
  listMountEl.querySelectorAll('.wb-row.highlighted').forEach((n) => n.classList.remove('highlighted'))
  if (activeNoteId == null) return false
  const row = listMountEl.querySelector(`.wb-row[data-note-id="${activeNoteId}"]`)
  if (row) {
    row.classList.add('highlighted')
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    setTimeout(() => row.classList.remove('highlighted'), 1600)
    return true
  }
  return false
}

function closeDetailPanel() {
  if (!detailPanelEl) return
  detailPanelEl.classList.add('hidden')
  detailPanelEl.replaceChildren()
  document.body.classList.remove('body-scroll-locked')
  if (lastFocusedBeforeDetail && typeof lastFocusedBeforeDetail.focus === 'function') {
    lastFocusedBeforeDetail.focus()
  }
  lastFocusedBeforeDetail = null
}

// P0-8: this panel does not implement a full focus trap, so it must not
// claim role="dialog"/aria-modal — that combination without real modal
// behavior is exactly the accessibility anti-pattern flagged in GPT's
// review. It's a non-modal complementary panel instead: Esc closes it and
// focus moves to/from it, but Tab is free to leave.
function renderDetailShell(headerChildren = [], bodyChildren = []) {
  if (!detailPanelEl) return
  const wasHidden = detailPanelEl.classList.contains('hidden')
  if (wasHidden) {
    lastFocusedBeforeDetail = document.activeElement
    document.body.classList.add('body-scroll-locked')
  }
  detailPanelEl.classList.remove('hidden')
  detailPanelEl.setAttribute('role', 'region')

  const closeBtn = el('button', {
    class: 'detail-close',
    type: 'button',
    'aria-label': '關閉詳情',
    text: '✕',
    onclick: () => clearNoteHash(),
  })
  const stickyHeader = el('div', { class: 'detail-sticky-header' }, [closeBtn, ...headerChildren])
  const scrollBody = el('div', { class: 'detail-scroll-body' }, bodyChildren)
  detailPanelEl.replaceChildren(stickyHeader, scrollBody)

  if (wasHidden) closeBtn.focus()
}

function renderDetailLoading() {
  renderDetailShell([], [el('p', { text: '載入中…' })])
}

// Same message for "doesn't exist" and "not yours" — id=427 §一.7: never
// reveal whether an id exists to someone who can't read it.
function renderDetailMessage(text) {
  renderDetailShell([], [el('p', { class: 'detail-message', text })])
}

function renderDetailTrashMessage(note) {
  const restoreBtn = el('button', {
    type: 'button',
    class: 'restore-btn',
    text: '復原',
    onclick: async () => {
      try {
        await restoreNote(note.id)
        if (listMountEl) refreshList(listMountEl)
        syncDetailFromHash()
        showToast('已復原')
      } catch (err) {
        showToast(friendlyErrorMessage(err))
      }
    },
  })
  const goTrash = el('button', {
    type: 'button',
    class: 'trash-toggle',
    text: '前往垃圾桶',
    onclick: () => {
      filters = { ...filters, trash: true }
      if (listMountEl) refreshList(listMountEl)
    },
  })
  renderDetailShell(
    [el('h2', { class: 'detail-title', text: note.title || '(無標題)' })],
    [el('p', { class: 'detail-message', text: '此便利貼位於垃圾桶。' }), el('div', { class: 'note-actions' }, [restoreBtn, goTrash])]
  )
}

function renderDetailNote(note, { foundInList } = {}) {
  let editing = false

  const copyBtn = el('button', {
    class: 'copy-ref-btn',
    type: 'button',
    'aria-label': '複製白板引用',
    text: '🔗 複製引用',
  })
  copyBtn.addEventListener('click', async () => {
    const ok = await performCopy(note)
    if (ok) {
      copyBtn.classList.add('copied')
      copyBtn.textContent = '✓ 已複製'
      setTimeout(() => {
        copyBtn.classList.remove('copied')
        copyBtn.textContent = '🔗 複製引用'
      }, 1500)
    }
  })

  const editToggleBtn = el('button', {
    class: 'edit-toggle-btn',
    type: 'button',
    text: editing ? '完成' : '編輯',
    onclick: () => {
      editing = !editing
      draw()
    },
  })

  const deleteBtn = el('button', {
    class: 'delete-btn',
    type: 'button',
    text: '移到垃圾桶',
    onclick: async () => {
      try {
        await softDelete(note.id)
        if (listMountEl) refreshList(listMountEl)
        showToast('已移到垃圾桶', {
          actionLabel: '復原',
          onAction: async () => {
            try {
              await restoreNote(note.id)
              if (listMountEl) refreshList(listMountEl)
              syncDetailFromHash()
            } catch (err) {
              showToast(friendlyErrorMessage(err))
            }
          },
          duration: 5000,
        })
        syncDetailFromHash()
      } catch (err) {
        showToast(friendlyErrorMessage(err))
      }
    },
  })

  const bodyEl = el('div', { class: 'detail-body' })

  function draw() {
    editToggleBtn.textContent = editing ? '完成' : '編輯'
    bodyEl.replaceChildren(editing ? buildEditForm() : buildViewBody())
  }

  function buildViewBody() {
    const tags = Array.isArray(note.tags) ? note.tags : []
    const statusSelect = el('select', {}, STATUSES.map((s) => option(s, statusLabel(s))))
    statusSelect.value = STATUSES.includes(note.status) ? note.status : STATUSES[0]
    statusSelect.addEventListener('change', async () => {
      try {
        await updateStatus(note.id, statusSelect.value)
        note.status = statusSelect.value
        if (listMountEl) refreshList(listMountEl)
      } catch (err) {
        showToast(friendlyErrorMessage(err))
      }
    })

    const notInFilterNotice = foundInList === false ? el('p', { class: 'detail-message', text: '此 note 不在目前篩選結果。' }) : el('div')

    const tagsEl = tags.length
      ? el(
          'div',
          { class: 'note-tags' },
          tags.map((t) => el('span', { class: 'note-tag-pill', text: '#' + displayTag(t) }))
        )
      : el('p', { class: 'tag-empty-hint', text: '尚未加入標籤。加入 1–3 個你未來可能用來搜尋這則 note 的主題詞。' })

    return el('div', {}, [
      notInFilterNotice,
      el('pre', { class: 'detail-content', text: note.content }),
      tagsEl,
      el('div', { class: 'note-actions' }, [statusSelect, deleteBtn]),
    ])
  }

  function buildEditForm() {
    const titleInput = el('input', { type: 'text', placeholder: 'Topic（選填）' })
    titleInput.value = note.title || ''
    const contentInput = el('textarea', { rows: '8' })
    contentInput.value = note.content
    const projectSelect = el('select', {}, PROJECT_KEYS.map((k) => option(k, projectLabel(k))))
    projectSelect.value = note.project_key
    const sourceSelect = el('select', {}, SOURCE_TYPES.map((k) => option(k, sourceLabel(k))))
    sourceSelect.value = note.source_type
    const recipientSelect = el('select', {}, [option('', '不指定'), ...buildRecipientOptions()])
    recipientSelect.value = note.recipient || ''
    const tagEditor = buildTagChipEditor({ initialTags: note.tags || [], onChange: () => scheduleSave() })

    const saveStatusEl = el('span', { class: 'save-status' })
    let saveTimer = null

    async function doSave() {
      saveStatusEl.textContent = '儲存中…'
      const fields = {
        title: titleInput.value.trim(),
        content: contentInput.value,
        projectKey: projectSelect.value,
        sourceType: sourceSelect.value,
        recipient: recipientSelect.value || null,
        tags: tagEditor.getTags(),
      }
      try {
        await updateNote(note.id, fields)
        Object.assign(note, {
          title: fields.title,
          content: fields.content,
          project_key: fields.projectKey,
          source_type: fields.sourceType,
          recipient: fields.recipient,
          tags: fields.tags,
          updated_at: new Date().toISOString(),
        })
        saveStatusEl.textContent = '已儲存'
        if (listMountEl) refreshList(listMountEl)
      } catch (err) {
        saveStatusEl.textContent = '儲存失敗（內容仍保留）：' + friendlyErrorMessage(err)
      }
    }

    const scheduleSave = () => {
      saveStatusEl.textContent = '編輯中…'
      clearTimeout(saveTimer)
      saveTimer = setTimeout(doSave, 800)
    }
    ;[titleInput, contentInput].forEach((elm) => elm.addEventListener('input', scheduleSave))
    ;[projectSelect, sourceSelect, recipientSelect].forEach((elm) => elm.addEventListener('change', scheduleSave))

    return el('div', { class: 'detail-edit-form' }, [
      el('label', { class: 'field-label' }, [el('span', { text: 'Topic' }), titleInput]),
      el('label', { class: 'field-label' }, [el('span', { text: 'Payload' }), contentInput]),
      el('label', { class: 'field-label' }, [el('span', { text: '專案' }), projectSelect]),
      el('label', { class: 'field-label' }, [el('span', { text: '來源' }), sourceSelect]),
      el('label', { class: 'field-label' }, [el('span', { text: 'To' }), recipientSelect]),
      tagField(tagEditor, { label: '標籤' }),
      saveStatusEl,
    ])
  }

  draw()

  renderDetailShell(
    [
      el('div', { class: 'detail-header-actions' }, [copyBtn, editToggleBtn]),
      el('h2', { class: 'detail-title', text: note.title || '(無標題)' }),
      el('div', { class: 'detail-badges' }, [
        el('span', { class: 'badge badge-from' }, [el('span', { text: fromLabel(note.created_by_label) })]),
        note.recipient
          ? el('span', { class: 'badge badge-to-set', text: note.recipient })
          : el('span', { class: 'badge-to-unset', text: '未指名' }),
        el('span', { class: 'tag-project', text: projectLabel(note.project_key) }),
      ]),
      el('p', { class: 'detail-time-meta', text: formatTimeMeta(note) }),
    ],
    [bodyEl]
  )
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && detailPanelEl && !detailPanelEl.classList.contains('hidden')) {
    clearNoteHash()
  }
})

async function syncDetailFromHash() {
  if (!currentSession || !detailPanelEl) return
  const id = getNoteIdFromHash()
  activeNoteId = id

  if (id == null) {
    applyHighlight()
    closeDetailPanel()
    return
  }

  const foundInList = applyHighlight()
  renderDetailLoading()
  try {
    const note = await getNoteById(id)
    if (!note) {
      renderDetailMessage('找不到這則便利貼，或你沒有查看權限。')
      return
    }
    if (note.deleted_at) {
      renderDetailTrashMessage(note)
      return
    }
    renderDetailNote(note, { foundInList })
  } catch (err) {
    renderDetailMessage(friendlyErrorMessage(err))
  }
}

onHashChange(syncDetailFromHash)

onAuthChange((session) => {
  currentSession = session
  render()
})
