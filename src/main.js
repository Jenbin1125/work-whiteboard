import { onAuthChange, signInWithGoogle, signOut } from './auth.js'
import {
  PROJECT_KEYS,
  SOURCE_TYPES,
  STATUSES,
  STATUS_TABS,
  RECIPIENTS,
  UNSET_RECIPIENT,
  PAGE_SIZE,
  listNotes,
  getStatusCounts,
  createNote,
  updateNote,
  updateStatus,
  softDelete,
  restoreNote,
  hardDeleteNote,
  getNoteById,
  searchNotesForReply,
  listReplies,
  getReplyTrailUp,
  scanReplyTree,
  findPendingLeaves,
} from './whiteboard.js'
import { loadDraft, saveDraft, clearDraft } from './draft.js'
import { getNoteIdFromHash, navigateToNote, clearNoteHash, onHashChange } from './router.js'
import { buildReferenceText, buildAttachmentReferenceText, copyToClipboard } from './copyReference.js'
import { statusLabel, projectLabel, sourceLabel, fromLabel, recipientLabel, RECIPIENT_GROUPS, noteTitleOrExcerpt } from './labels.js'
import { friendlyErrorMessage } from './friendlyError.js'
import { extractFootballPreview } from './footballPreview.js'
import { normalizeTag, displayTag, validateNewTag, getTagStats, invalidateTagStats, rankTagSuggestions } from './tags.js'
import { iconUser, iconLink, iconPaperclip, iconTrash, iconCopy, iconChevronRight, iconReply } from './icons.js'
import {
  ALLOWED_MIME_TYPES,
  MAX_FILES_PER_NOTE,
  MAX_TOTAL_BYTES_PER_NOTE,
  IMAGE_MIME_TYPES,
  TEXT_MIME_TYPES,
  resolveMimeType,
  validateAttachmentCandidate,
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
let filters = { projectKey: '', status: '', source: '', tags: [], trash: false, from: '', to: '', search: '', sort: undefined }
let activeNoteId = null
let detailPanelEl = null
let listMountEl = null
let openMenuCloser = null
let copyInFlight = false
// Set by renderFilters() each time the board renders; lets row-level tag
// chips (id=433 §三.2) push a tag into the filter state + popover editor
// without threading the filter closures through renderRow's call chain.
let addTagFilterFn = null
// Same lazy-binding pattern as addTagFilterFn, but for the id=434 §五 status
// quick-tabs <-> filter popover's status <select> staying in sync regardless
// of which one triggered the change.
let setStatusFilterFn = null
let statusTabsRef = null
// id=440: set by renderBoard() each render; lets a row's or the detail
// panel's "回覆" button reach into Compose's reply-target state without
// threading it through renderRow/renderDetailNote's call chains (same
// lazy-binding pattern as statusTabsRef/addTagFilterFn above).
let composeFormRef = null
// id=434 §八: pagination state for the current filtered view. Reset to page
// 1 by refreshList(); loadMoreNotes() appends the next page onto this.
let currentNotes = []
let hasMoreNotes = false
let tagEditorSeq = 0
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
  composeFormRef = null
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

// id=434 §十: title + tagline replace the old technical-feeling "Work
// Whiteboard" heading; email moves behind this menu so the main screen reads
// less like an admin console. Note: the spec's mockup also lists "同步狀態"
// (sync status) next to the user menu — skipped here since this app has no
// underlying sync/offline state to report; adding a fake always-synced badge
// would just be misleading UI, not a real status.
function buildUserMenu() {
  const popover = el('div', { class: 'user-menu-popover hidden' })
  popover.appendChild(el('div', { class: 'user-menu-email', text: currentSession.user.email || '' }))
  popover.appendChild(el('button', { type: 'button', class: 'user-menu-signout', text: '登出', onclick: () => signOut() }))

  const close = () => {
    popover.classList.add('hidden')
    if (openMenuCloser === close) openMenuCloser = null
  }
  const btn = el(
    'button',
    {
      type: 'button',
      class: 'user-menu-btn',
      'aria-label': '使用者選單',
      title: currentSession.user.email || '使用者選單',
      onclick: (e) => {
        e.stopPropagation()
        const wasHidden = popover.classList.contains('hidden')
        if (openMenuCloser) openMenuCloser()
        if (wasHidden) {
          popover.classList.remove('hidden')
          openMenuCloser = close
        }
      },
    },
    [iconUser()]
  )

  return el('div', { class: 'user-menu' }, [btn, popover])
}

function renderBoard() {
  const container = el('div', { class: 'board' })

  // id=435 §五.1: PHI reminder lives at the page header now — a single
  // site-wide notice (not Compose-specific, not list-specific), low visual
  // weight, sits between the title block and the user menu. This supersedes
  // §四.4's "top of the list column" placement and fully replaces the old
  // Compose-form warning (removed below in renderNoteForm).
  const header = el('header', {}, [
    el('div', { class: 'header-titles' }, [
      el('h1', { text: '工作白板' }),
      el('p', { class: 'header-tagline', text: '快速留下、稍後整理' }),
    ]),
    el('p', { class: 'header-phi-note', text: '⚠️ 請勿貼入病人可辨識資訊（PHI）、密碼、API key/token，或未經授權的受版權內容。' }),
    buildUserMenu(),
  ])
  container.appendChild(header)

  const listMount = el('div', { class: 'list-mount' })
  listMountEl = listMount

  const isMobile = window.matchMedia('(max-width: 900px)').matches
  const composeForm = renderNoteForm({ startOpen: !isMobile })
  composeFormRef = composeForm
  const statusTabs = buildStatusTabs()
  const listCol = el('div', { class: 'list-col' }, [statusTabs.element, renderFilters(listMount), listMount])
  const formCol = el('div', { class: 'form-col' }, [composeForm.element])

  container.appendChild(el('div', { class: 'board-grid' }, [formCol, listCol]))

  detailPanelEl = el('aside', { class: 'detail-panel hidden', 'aria-label': '便利貼詳情' })
  container.appendChild(detailPanelEl)

  refreshList(listMount).then((notes) => {
    // Mobile: an empty board still opens the compose form so first-time use
    // isn't a mystery; once notes exist it stays collapsed to keep the inbox
    // above the fold (id=432 §四).
    if (isMobile && notes && notes.length === 0) composeForm.element.open = true
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

  // id=440 §一: which existing note (if any) this new note replies to. Not
  // persisted to the draft (unlike stagedFiles, this IS JSON-serializable,
  // but a reply relationship surviving a browser refresh days later would
  // more likely confuse than help — same reasoning as stagedFiles staying
  // in-memory-only, just for a different underlying reason).
  let replyTarget = null // { id, label } | null
  const replyChip = buildReplyChip(() => {
    replyTarget = null
    replyChip.render(null)
    // id=440 §四 (Scribe #142 定案): cancelling a reply must reset 寄/收
    // back to their normal defaults too — leaving 收 on the auto-filled
    // value (or 寄 on whatever it happened to be) after the banner
    // disappears would look cancelled but silently leave stale field
    // values behind. This is the one real UI-consistency bug in the
    // ticket; 寄 was never auto-swapped in the first place (see
    // startReply below), so there was nothing to "not change" there —
    // this reset just restores both fields to their normal post-submit
    // defaults, same as a completed submit already does.
    toSelect.value = ''
    fromSelect.value = 'Human-Jenbin'
    persistDraft()
  })
  const replySearch = buildReplySearchField({
    onSelect: (n) => {
      replyTarget = { id: n.id, label: noteTitleOrExcerpt(n) }
      replyChip.render(replyTarget)
    },
  })

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

  const status = el('p', { class: 'form-status' })
  // id=435 §六: text only ("新增" -> "送出"); §五.2: right-aligned (see the
  // .compose-submit-row justify-content change in style.css) — trigger
  // logic and post-submit behavior are both unchanged.
  const submitBtn = el('button', { type: 'submit', text: '送出' })

  // id=431 §十一: files picked in Compose can't be uploaded yet (no note_id
  // exists), so they're staged client-side only — no pending row, no Storage
  // call — until submit creates the note and relay-uploads them. Never
  // persisted to the draft (Files aren't JSON-serializable, and a lost
  // selection on reload is the same limitation a plain <input type=file>
  // already has everywhere else).
  let stagedFiles = [] // { file, mimeType }[]
  const stagedFilesRow = el('div', { class: 'staged-files-row' })
  const stagedFilesError = el('p', { class: 'wba-error hidden' })
  const attachFileInput = el('input', { type: 'file', class: 'hidden', accept: ALLOWED_MIME_TYPES.join(',') })

  function renderStagedFiles() {
    stagedFilesRow.replaceChildren(
      ...stagedFiles.map(({ file }, i) =>
        el('span', { class: 'tag-chip' }, [
          el('span', { text: file.name }),
          el('button', {
            type: 'button',
            'aria-label': '移除 ' + file.name,
            text: '×',
            onclick: () => {
              stagedFiles.splice(i, 1)
              renderStagedFiles()
            },
          }),
        ])
      )
    )
  }

  const attachFileBtn = el(
    'button',
    { type: 'button', class: 'attach-file-btn', onclick: () => attachFileInput.click() },
    [iconPaperclip(), el('span', { text: '附加檔案' })]
  )
  attachFileInput.addEventListener('change', () => {
    const file = attachFileInput.files[0]
    attachFileInput.value = ''
    if (!file) return
    stagedFilesError.classList.add('hidden')
    const totalBytes = stagedFiles.reduce((sum, s) => sum + s.file.size, 0)
    const check = validateAttachmentCandidate(file, { count: stagedFiles.length, totalBytes })
    if (!check.ok) {
      stagedFilesError.textContent = check.error
      stagedFilesError.classList.remove('hidden')
      return
    }
    stagedFiles.push({ file, mimeType: check.mimeType })
    renderStagedFiles()
  })

  const doSubmit = async () => {
    status.textContent = ''
    const content = contentInput.value
    if (!content || !content.trim()) {
      status.textContent = '內容不可為空。'
      return
    }
    const tags = tagEditor.getTags()
    const filesToUpload = stagedFiles

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
        replyToNoteId: replyTarget ? replyTarget.id : null,
      })
      titleInput.value = ''
      contentInput.value = ''
      toSelect.value = ''
      tagEditor.setTags([])
      fromSelect.value = 'Human-Jenbin'
      stagedFiles = []
      renderStagedFiles()
      stagedFilesError.classList.add('hidden')
      replyTarget = null
      replyChip.render(null)
      clearDraft()
      invalidateTagStats()
      // id=431 §十一.1: relay-upload now that a note id exists. A failed
      // file must never roll back the note or block the other files —
      // each keeps its own outcome, shown via the row's existing
      // pending/uploading/ready/failed handling (id=431 §二).
      expandedIds.add(newNote.id)
      if (listMountEl) refreshList(listMountEl)
      if (statusTabsRef) statusTabsRef.reload()
      showToast('已建立便利貼', {
        actionLabel: '開啟詳情',
        onAction: () => navigateToNote(newNote.id),
        duration: 4000,
      })
      if (filesToUpload.length) {
        Promise.allSettled(
          filesToUpload.map(({ file, mimeType }) => uploadAttachment({ noteId: newNote.id, ownerUid: currentSession.user.id, file, mimeType }))
        ).then(() => {
          // This app has no realtime push — a second fetch is how "watch it
          // finish" already works elsewhere (e.g. status-tab counts), so the
          // row picks up each file's final ready/failed state once settled.
          if (listMountEl) refreshList(listMountEl)
        })
      }
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

  // id=435 §四.2: "發件身分"/"To" renamed to the single-character "寄"/"收"
  // (same vocabulary now used on the row badges too, see buildRowFromTo()).
  // §四.3 removed the hint paragraph that used to sit under this field — the
  // Compose form only has one real user (Human, the only one who can log
  // in), so it added no clarification value for anyone actually seeing it.
  const fromField = el('label', { class: 'field-label' }, [el('span', { text: '寄' }), fromSelect])
  const toField = el('label', { class: 'field-label' }, [el('span', { text: '收' }), toSelect])
  const moreFields = el('div', { class: 'row' }, [labeledField('專案', projectSelect), labeledField('來源', sourceSelect), tagField(tagEditor)])
  // id=440 §1.2: manual reply-target search — secondary entry point, lives
  // in "更多分類" since the primary entry is a row/detail "回覆" button
  // (see startReply() below). No excludeId: a brand-new note has no id of
  // its own yet, so there's nothing to self-exclude.
  const replyField = el('label', { class: 'field-label' }, [el('span', { text: '回覆對象（選填）' }), replySearch])
  // "更多分類"'s own border-top already reads as the spec's divider line
  // above it — no separate <hr> needed.
  const moreDetails = el('details', { class: 'compose-more' }, [el('summary', { text: '更多分類' }), moreFields, replyField])

  // id=435 §一.1/§四: Topic -> Payload -> 寄 -> 收 -> 送出(靠右) -> 更多分類.
  // This is an explicit Human-directed reversal of id=432 §四's
  // "content-first" ordering (Payload was first) — not an oversight; per the
  // spec, id=432 §四's ordering description is superseded by this. The PHI
  // warning that used to sit here is gone entirely (id=435 §四.4/§五 moved
  // it to the page header instead — see renderBoard()).
  // id=440 §一: visible confirmation of the current reply target, shown
  // above every field so it's the first thing seen after the row/detail
  // "回覆" button opens Compose — hidden entirely when not replying.
  form.appendChild(replyChip.element)
  form.appendChild(titleInput)
  form.appendChild(contentInput)
  form.appendChild(fromField)
  form.appendChild(toField)
  // id=435 §七: 附加檔案 (left) and 送出 (right) share one row.
  form.appendChild(el('div', { class: 'compose-submit-row' }, [attachFileBtn, submitBtn]))
  form.appendChild(stagedFilesRow)
  form.appendChild(stagedFilesError)
  form.appendChild(attachFileInput)
  form.appendChild(status)
  form.appendChild(moreDetails)

  // Native <details> gives a free, accessible collapse/expand on narrow
  // screens without extra JS. <summary> must be a direct child of <details>
  // or the browser ignores it and renders its own default toggle instead.
  const details = el('details', { class: 'compose-details' }, [el('summary', { text: '貼上筆記' }), form])
  if (startOpen) details.open = true

  details.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') details.open = false
  })

  // id=440 §1.1: primary reply entry point, called from a row's or the
  // detail panel's "回覆" button. Sets the internal reply-target state
  // (never a raw id shown to the user — the chip renders the note's title
  // instead), opens Compose, and scrolls/focuses it so the response to
  // clicking "回覆" is immediately visible rather than a silent state
  // change somewhere off-screen (relevant on mobile, where Compose starts
  // collapsed and the list can be scrolled well past it).
  function startReply(note) {
    replyTarget = { id: note.id, label: noteTitleOrExcerpt(note) }
    replyChip.render(replyTarget)
    // id=440 §四 (Scribe #142 定案, superseding UI-Claude's original
    // email-reply assumption): 寄 is deliberately NEVER touched here — it
    // was never auto-swapped to begin with, and Scribe's argument (this
    // board's actual pattern is relay handoffs, A→B→C, not two-party
    // back-and-forth, so guessing "原收件人" would often be wrong anyway;
    // also, whether you're transcribing another agent's words or speaking
    // as yourself is something only the human at the keyboard knows) is
    // why it stays manual, defaulting to Human-Jenbin. 收's auto-fill
    // below is confirmed correct and unchanged — only applied if the user
    // hasn't already chosen a 收 value for an in-progress draft, so this
    // never clobbers their pick.
    if (!toSelect.value && note.created_by_label && RECIPIENTS.includes(note.created_by_label)) {
      toSelect.value = note.created_by_label
      persistDraft()
    }
    details.open = true
    details.scrollIntoView({ behavior: 'smooth', block: 'start' })
    contentInput.focus()
  }

  return { element: details, startReply }
}

function labeledField(labelText, control) {
  return el('label', { class: 'field-label field-label-compact' }, [el('span', { text: labelText }), control])
}

// id=440 §1.2: shared "回覆對象" manual search input + results list. Purely
// presentational — selecting a result calls onSelect(note); the caller owns
// the actual reply-target state, since Compose and the detail edit form
// each have a different chip placement/lifecycle for it. excludeId is the
// note being edited (if any), so it can't select itself as its own parent.
// This is a plain click-to-select list, not a full ARIA combobox like the
// tag editor's (id=434 §二) — arrow-key roving wasn't in id=440's
// acceptance checklist, so it's out of scope for this pass.
function buildReplySearchField({ excludeId, onSelect } = {}) {
  const searchInput = el('input', { type: 'text', placeholder: '搜尋標題或 id…', 'aria-label': '搜尋回覆對象' })
  const resultsEl = el('ul', { class: 'reply-search-results hidden' })

  const closeResults = () => {
    resultsEl.classList.add('hidden')
    resultsEl.replaceChildren()
  }

  const runSearch = debounce(async () => {
    const q = searchInput.value.trim()
    if (!q) return closeResults()
    let results
    try {
      results = await searchNotesForReply(q, { excludeId })
    } catch {
      return closeResults()
    }
    resultsEl.replaceChildren(
      ...(results.length
        ? results.map((n) =>
            el('li', {}, [
              el('button', {
                type: 'button',
                text: `#${n.id} ${noteTitleOrExcerpt(n)}`,
                onclick: () => {
                  closeResults()
                  searchInput.value = ''
                  onSelect(n)
                },
              }),
            ])
          )
        : [el('li', { class: 'reply-search-empty', text: '找不到符合的 note' })])
    )
    resultsEl.classList.remove('hidden')
  }, 300)
  searchInput.addEventListener('input', runSearch)
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeResults()
    }
  })

  return el('div', { class: 'reply-search-field' }, [searchInput, resultsEl])
}

// id=440: shared reply-target chip — shows what a note (new or existing)
// is currently set to reply to, with a clear (×) button. Compose and the
// detail edit form each own their own target state and pass it a setter.
function buildReplyChip(onClear) {
  const chipEl = el('div', { class: 'reply-target-chip hidden' })
  function render(target) {
    if (!target) {
      chipEl.classList.add('hidden')
      chipEl.replaceChildren()
      return
    }
    chipEl.classList.remove('hidden')
    chipEl.replaceChildren(
      iconReply(),
      el('span', { text: `回覆：#${target.id} ${target.label}` }),
      el('button', { type: 'button', 'aria-label': '取消回覆對象', text: '×', onclick: onClear })
    )
  }
  return { element: chipEl, render }
}

// id=434 §三.1: Chinese name as the primary label, canonical value as a
// small parenthetical secondary — native <option> can't do two-line text, so
// this is the best approximation of "中文名為主，canonical 值為次要小字".
function buildRecipientOptions() {
  const opts = []
  for (const group of RECIPIENT_GROUPS) {
    const optGroup = el('optgroup', { label: group.label })
    group.values.forEach((v) => optGroup.appendChild(option(v, `${recipientLabel(v)}（${v}）`)))
    opts.push(optGroup)
  }
  return opts
}

// --- tag chip editor (id=433 §一/§二/§六, id=434 §二/§七): shared by
// Compose, the detail edit form, and the filter popover's tag multi-select.
// The suggestion dropdown is a standard combobox/listbox: ↓/↑ moves the
// highlighted option, Enter picks it (or adds the typed text raw if nothing
// is highlighted), Esc closes the list without touching the typed text, Tab
// is left untouched. getTagStats() itself is the shared TTL'd cache (tags.js
// id=434 §七) — every render call here goes through it fresh rather than
// keeping a separate per-editor-instance cache that could go stale after
// another editor's write invalidates the shared one. -----------------------
function buildTagChipEditor({ initialTags = [], onChange } = {}) {
  let tags = [...initialTags]
  // { tag, count?, raw?, isNew } — the currently rendered suggestion list,
  // in display order, so keyboard nav can index into it directly.
  let suggestionEntries = []
  let highlightedIndex = -1
  const editorId = 'tag-editor-' + ++tagEditorSeq

  const row = el('div', { class: 'tag-chips-row' })
  const input = el('input', {
    type: 'text',
    class: 'tag-chip-input',
    placeholder: '輸入標籤…',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-autocomplete': 'list',
    'aria-haspopup': 'listbox',
    'aria-controls': editorId + '-listbox',
  })
  row.appendChild(input)
  const dupHint = el('span', { class: 'tag-dup-hint hidden', text: '已經加入這個標籤' })
  const limitHint = el('span', { class: 'tag-dup-hint hidden' })
  const suggestionsEl = el('ul', { id: editorId + '-listbox', class: 'tag-suggestions hidden', role: 'listbox', 'aria-label': '標籤建議' })
  const recentEl = el('div', { class: 'tag-recent hidden' })

  function optionId(i) {
    return editorId + '-opt-' + i
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
    return true
  }

  function closeSuggestions() {
    suggestionEntries = []
    highlightedIndex = -1
    suggestionsEl.replaceChildren()
    suggestionsEl.classList.add('hidden')
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
  }

  function chooseEntry(entry) {
    tryAdd(entry.isNew ? entry.raw : entry.tag)
    input.value = ''
    closeSuggestions()
    input.focus()
  }

  function drawSuggestions() {
    if (!suggestionEntries.length) {
      closeSuggestions()
      return
    }
    const items = suggestionEntries.map((entry, i) => {
      const selected = i === highlightedIndex
      const btn = entry.isNew
        ? el('button', { type: 'button', class: 'tag-suggestion-btn tag-suggestion-new', text: `建立新標籤「${entry.raw}」`, tabindex: '-1', onclick: (e) => { e.stopPropagation(); chooseEntry(entry) } })
        : el(
            'button',
            { type: 'button', class: 'tag-suggestion-btn', tabindex: '-1', onclick: (e) => { e.stopPropagation(); chooseEntry(entry) } },
            [el('span', { text: displayTag(entry.tag) }), el('span', { class: 'tag-suggestion-count', text: entry.count + ' 則' })]
          )
      return el('li', { id: optionId(i), role: 'option', 'aria-selected': String(selected), class: selected ? 'tag-suggestion-active' : '' }, [btn])
    })
    suggestionsEl.replaceChildren(...items)
    suggestionsEl.classList.remove('hidden')
    input.setAttribute('aria-expanded', 'true')
    if (highlightedIndex >= 0) input.setAttribute('aria-activedescendant', optionId(highlightedIndex))
    else input.removeAttribute('aria-activedescendant')
  }

  // Re-fetches through the shared cache every time (cheap once warm/cached)
  // rather than latching a local "already loaded" flag, so an invalidation
  // from another editor's write is picked up on the very next keystroke.
  async function renderSuggestions() {
    const q = input.value.trim()
    if (!q) {
      closeSuggestions()
      return
    }
    const stats = await getTagStats().catch(() => [])
    if (input.value.trim() !== q) return // stale response, input changed while awaiting
    const ranked = rankTagSuggestions(stats, q).filter((s) => !tags.includes(s.tag))
    const entries = ranked.slice(0, 8).map((s) => ({ tag: s.tag, count: s.count, isNew: false }))
    const normalizedQ = normalizeTag(q)
    if (normalizedQ && !entries.some((e) => e.tag === normalizedQ) && !tags.includes(normalizedQ)) {
      entries.push({ tag: normalizedQ, raw: q, isNew: true })
    }
    suggestionEntries = entries
    highlightedIndex = -1
    drawSuggestions()
  }

  async function renderRecent() {
    const stats = await getTagStats().catch(() => [])
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
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      if (!suggestionEntries.length) return
      e.preventDefault()
      highlightedIndex = (highlightedIndex + 1) % suggestionEntries.length
      drawSuggestions()
    } else if (e.key === 'ArrowUp') {
      if (!suggestionEntries.length) return
      e.preventDefault()
      highlightedIndex = (highlightedIndex - 1 + suggestionEntries.length) % suggestionEntries.length
      drawSuggestions()
    } else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      if (highlightedIndex >= 0 && suggestionEntries[highlightedIndex]) {
        chooseEntry(suggestionEntries[highlightedIndex])
        return
      }
      const v = input.value.replace(/,$/, '')
      if (v.trim()) tryAdd(v)
      input.value = ''
      closeSuggestions()
    } else if (e.key === 'Escape') {
      // Only intercept when there's actually a list to close — otherwise let
      // Esc bubble (e.g. to the Compose <details>'s own close-on-Esc). When
      // we DO close it, stopPropagation too — without it the same keypress
      // still bubbles up and closes the whole Compose panel out from under
      // the user, which is worse than doing nothing.
      if (suggestionEntries.length) {
        e.preventDefault()
        e.stopPropagation()
        closeSuggestions()
      }
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      tags = tags.slice(0, -1)
      renderChips()
      onChange && onChange([...tags])
    }
    // Tab: no handling — default focus-move proceeds untouched.
  })
  input.addEventListener('input', renderSuggestions)
  input.addEventListener('focus', renderSuggestions)
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

// id=434 §五: life-cycle counts, not an unread tracker (id=432 §九 still
// shelved) — clicking a tab applies the same status filter the popover's
// <select> uses (see setStatus() inside renderFilters), just as a faster
// entry point.
function buildStatusTabs() {
  const wrap = el('div', { class: 'status-tabs' })

  function updateActive() {
    wrap.querySelectorAll('.status-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.status === filters.status)
    })
  }

  function draw(counts) {
    wrap.replaceChildren(
      ...STATUS_TABS.map((s) =>
        el(
          'button',
          {
            type: 'button',
            class: 'status-tab' + (filters.status === s ? ' active' : ''),
            'data-status': s,
            onclick: () => setStatusFilterFn && setStatusFilterFn(s),
          },
          [el('span', { text: statusLabel(s) }), el('span', { class: 'status-tab-count', text: String(counts[s] ?? 0) })]
        )
      )
    )
  }

  async function reload() {
    try {
      draw(await getStatusCounts())
    } catch {
      // Non-critical: counts failing to load shouldn't block the list itself.
      wrap.replaceChildren()
    }
  }

  reload()
  const ref = { element: wrap, reload, updateActive }
  statusTabsRef = ref
  return ref
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
  const fromInput = el('input', { type: 'text', placeholder: '寄件篩選' })
  const toSelect = el('select', {}, [option('', '全部收件人'), option(UNSET_RECIPIENT, '未指名'), ...buildRecipientOptions()])
  const sortSelect = el('select', {}, [option('updated_desc', '最近更新'), option('created_desc', '最新建立'), option('oldest_raw', '最舊待整理')])
  sortSelect.value = 'updated_desc'

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
    // id=435 §四.2 extension: same "寄/收" vocabulary as Compose + the row
    // badges, applied here too so it's consistent everywhere the concept
    // shows up (the spec's own wording: "同一套「寄/收」語彙貫穿列表與表單").
    labeledField('寄', fromInput),
    labeledField('收', toSelect),
    labeledField('排序', sortSelect),
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

  // Status is deliberately NOT included here — it has its own setStatus()
  // below, because it can be driven by three different controls (this
  // select, the status quick-tabs, and the "最舊待整理" sort preset) and one
  // of those (the tabs) can set a value ('extracted') this <select> has no
  // option for. If apply() also copied statusSelect.value on every change,
  // any unrelated filter edit would silently stomp an extracted-tab filter
  // back to '' the moment the user touched another control.
  function apply() {
    filters = {
      ...filters,
      projectKey: projectSelect.value,
      source: sourceSelect.value,
      from: fromInput.value.trim(),
      to: toSelect.value,
      search: searchInput.value.trim(),
    }
    renderChips()
    refreshList(listMount)
  }

  // Single source of truth for filters.status — keeps the <select>, the
  // quick-tabs' active state, and the active-filter chip all in sync
  // regardless of which one triggered the change.
  function setStatus(status) {
    filters = { ...filters, status }
    statusSelect.value = STATUSES.includes(status) ? status : ''
    renderChips()
    refreshList(listMount)
    if (statusTabsRef) statusTabsRef.updateActive()
  }

  // id=434 §六: "最舊待整理" is a preset, not just an ORDER BY — it also
  // pins the status filter to raw so it actually reads as "clear the inbox"
  // (listNotes() itself never forces this; see whiteboard.js's note on why).
  // Switching away from it afterward does NOT auto-clear status=raw — that'd
  // be surprising the other direction (silently dropping a filter the user
  // set), so status stays until cleared explicitly like any other filter.
  function applySort() {
    const val = sortSelect.value
    if (val === 'oldest_raw') {
      filters = { ...filters, sort: 'created_asc' }
      setStatus('raw')
      return
    } else if (val === 'created_desc') {
      filters = { ...filters, sort: 'created_desc' }
    } else {
      filters = { ...filters, sort: undefined }
    }
    renderChips()
    refreshList(listMount)
  }

  function clearAllFilters() {
    searchInput.value = ''
    projectSelect.value = ''
    sourceSelect.value = ''
    fromInput.value = ''
    toSelect.value = ''
    sortSelect.value = 'updated_desc'
    tagFilterEditor.setTags([])
    filters = { ...filters, tags: [], sort: undefined, status: '' }
    statusSelect.value = ''
    apply()
    if (statusTabsRef) statusTabsRef.updateActive()
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

  // id=434 §五: lets the status quick-tabs (built alongside renderFilters in
  // renderBoard) drive the same filters.status the popover's <select> does —
  // clicking the active tab again clears it, matching a normal toggle chip.
  setStatusFilterFn = (status) => setStatus(filters.status === status ? '' : status)

  function renderChips() {
    const chips = []
    if (filters.search) chips.push(['搜尋: ' + filters.search, () => clearOne('search', searchInput, '')])
    if (filters.projectKey) chips.push(['專案: ' + projectLabel(filters.projectKey), () => clearOne('projectKey', projectSelect, '')])
    if (filters.status) chips.push(['狀態: ' + statusLabel(filters.status), () => setStatus('')])
    if (filters.source) chips.push(['來源: ' + sourceLabel(filters.source), () => clearOne('source', sourceSelect, '')])
    if (filters.from) chips.push(['寄: ' + filters.from, () => clearOne('from', fromInput, '')])
    if (filters.to) chips.push(['收: ' + (filters.to === UNSET_RECIPIENT ? '未指名' : recipientLabel(filters.to)), () => clearOne('to', toSelect, '')])
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
  statusSelect.addEventListener('change', () => setStatus(statusSelect.value))
  sourceSelect.addEventListener('change', apply)
  sortSelect.addEventListener('change', applySort)
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

function buildListParams() {
  return {
    projectKey: filters.projectKey,
    status: filters.status,
    sourceType: filters.source,
    tags: filters.tags,
    trash: filters.trash,
    fromLabel: filters.from,
    to: filters.to,
    search: filters.search,
    sort: filters.sort,
  }
}

// id=434 §八: the "page 1" entry point — every filter/sort/trash-toggle
// change calls this (never loadMoreNotes), so pagination naturally resets
// whenever the query itself changes.
async function refreshList(mount) {
  mount.replaceChildren(el('p', { text: '載入中…' }))
  try {
    const notes = await listNotes({ ...buildListParams(), offset: 0, limit: PAGE_SIZE })
    currentNotes = notes
    hasMoreNotes = notes.length === PAGE_SIZE
    mount.replaceChildren(renderList(currentNotes, mount))
    applyHighlight()
    return notes
  } catch (err) {
    mount.replaceChildren(el('p', { class: 'error', text: friendlyErrorMessage(err) }))
    currentNotes = []
    hasMoreNotes = false
    return []
  }
}

async function loadMoreNotes(mount) {
  try {
    const more = await listNotes({ ...buildListParams(), offset: currentNotes.length, limit: PAGE_SIZE })
    currentNotes = [...currentNotes, ...more]
    hasMoreNotes = more.length === PAGE_SIZE
    mount.replaceChildren(renderList(currentNotes, mount))
    applyHighlight()
  } catch (err) {
    showToast(friendlyErrorMessage(err))
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
  const listEl = el('ul', { class: 'wb-list' }, items)
  if (!hasMoreNotes) return listEl
  const loadMoreBtn = el('button', { type: 'button', class: 'load-more-btn', text: '載入更多', onclick: () => loadMoreNotes(mount) })
  return el('div', {}, [listEl, loadMoreBtn])
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

  // id=435 §三.1: plain numeric id, no "id=" prefix, secondary/gray styling.
  const idEl = el('span', { class: 'wb-row-id', text: String(note.id) })

  // id=435 §四.2: the generic person icon is replaced by a single "寄"/"收"
  // character — same 寄/收 vocabulary as the Compose field labels now, so
  // list rows and the form read consistently (scoped to the list row only
  // per the spec; the detail panel's own badges below are untouched).
  const fromBadge = el('span', { class: 'badge badge-from' }, [el('span', { class: 'badge-kind', text: '寄' }), el('span', { text: fromLabel(note.created_by_label) })])

  const toBadge = note.recipient
    ? el('span', { class: 'badge badge-to-set' }, [el('span', { class: 'badge-kind', text: '收' }), el('span', { text: recipientLabel(note.recipient) })])
    : el('span', { class: 'badge-to-unset' }, [el('span', { class: 'badge-kind', text: '收' }), el('span', { text: '未指名' })])
  // id=435 §三.2: From/To stacked vertically (was side-by-side).
  const fromToStack = el('div', { class: 'wb-row-fromto' }, [fromBadge, toBadge])

  // id=438: 🏈 交棒卡-format notes preview the extracted「球（任務）」text
  // instead of Title/first-line — Title is often just a restated headline,
  // while the task line is what a recipient actually needs to judge
  // relevance at a glance. Non-🏈 notes, and 🏈 notes where extraction
  // fails, keep the exact prior fallback (id=438 §一.2 優雅降級).
  const topicText = extractFootballPreview(note.content) || noteTitleOrExcerpt(note)
  const topicEl = el('span', { class: 'wb-topic', text: topicText })
  // id=435 §四.1: reverts §三.3 — tags go back to their own line below
  // Topic (Human found the shared-line width too cramped in practice).
  const topicBlock = el('div', { class: 'wb-row-topic-block' }, [topicEl, buildRowTagChips(note)])

  const timeEl = el('span', { class: 'wb-time', text: new Date(note.created_at).toLocaleString() })

  const rowActions = buildRowActionIcons(note)

  // id=435 §三.6 mockup order: id -> From/To stack -> topic(+tags below it)
  // -> action icons -> time. The standalone chevron indicator (id=434 §九)
  // is removed per §三.5 — row-click-to-expand is unchanged, it just no
  // longer has a dedicated visual "button" implying a second way to trigger
  // the same thing.
  const rowMain = el(
    'div',
    { class: 'wb-row-main', role: 'button', tabindex: '0', 'aria-expanded': String(isExpanded) },
    [idEl, fromToStack, topicBlock, rowActions, timeEl]
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

  return el('li', { class: 'wb-row', 'data-note-id': String(note.id) }, [rowMain, expandSection])
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
      if (statusTabsRef) statusTabsRef.reload()
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
        if (statusTabsRef) statusTabsRef.reload()
        if (activeNoteId === note.id) syncDetailFromHash()
        showToast('已移到垃圾桶', {
          actionLabel: '復原',
          onAction: async () => {
            try {
              await restoreNote(note.id)
              refreshList(mount)
              if (statusTabsRef) statusTabsRef.reload()
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
        if (statusTabsRef) statusTabsRef.reload()
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
        if (statusTabsRef) statusTabsRef.reload()
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
// id=431§十二: hideWhenEmpty lets a call site (the detail panel) collapse
// the whole section away when a note has zero attachments, instead of
// always showing the header/add-button chrome — the row-expand call site
// omits this option and keeps its existing always-show behavior unchanged.
function buildAttachmentsSection(note, { hideWhenEmpty = false } = {}) {
  // Starts hidden in hideWhenEmpty mode so there's no flash of "載入中…"
  // chrome before the first load resolves and decides whether to show it.
  const container = el('div', { class: hideWhenEmpty ? 'wb-attachments-section hidden' : 'wb-attachments-section' })
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
    if (hideWhenEmpty) container.classList.toggle('hidden', currentAttachments.length === 0)
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
      // A fetch failure must stay visible even in hideWhenEmpty mode —
      // hiding it here would look like "confirmed zero attachments" when
      // it's actually "we don't know yet". renderAttachmentList() is the
      // only place that clears this 'hidden' class on the success path, so
      // the catch branch has to do it too, not just repaint listEl (幕僚長 #191).
      if (hideWhenEmpty) container.classList.remove('hidden')
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
    const totalBytes = currentAttachments.reduce((sum, a) => sum + (a.size_bytes || 0), 0)
    const check = validateAttachmentCandidate(file, { count: currentAttachments.length, totalBytes })
    if (!check.ok) {
      errorEl.textContent = check.error
      errorEl.classList.remove('hidden')
      return
    }

    try {
      await uploadAttachment({ noteId: note.id, ownerUid: currentSession.user.id, file, mimeType: check.mimeType })
    } catch (err) {
      errorEl.textContent = friendlyErrorMessage(err)
      errorEl.classList.remove('hidden')
    }
    await reload()
  })

  container.appendChild(el('div', { class: 'wba-header' }, [iconPaperclip(), el('span', { text: '附件' }), counterEl]))
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

  const copyRefBtn = el(
    'button',
    {
      class: 'wba-copy-btn',
      type: 'button',
      'aria-label': '複製附件引用',
      title: '複製附件引用',
      onclick: async (e) => {
        e.stopPropagation()
        try {
          await copyToClipboard(buildAttachmentReferenceText(noteId, att.original_name))
          showToast('已複製附件引用')
        } catch (err) {
          showToast(friendlyErrorMessage(err))
        }
      },
    },
    [iconLink()]
  )

  const deleteBtn = el(
    'button',
    {
      class: 'delete-btn',
      type: 'button',
      'aria-label': '刪除附件',
      title: '刪除附件',
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
    },
    [iconTrash()]
  )

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
      icon = iconPaperclip()
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

document.addEventListener('click', (e) => {
  if (openMenuCloser && !e.target.closest('.user-menu')) {
    openMenuCloser()
    openMenuCloser = null
  }
})

// id=427 §七's hover-tooltip -> "已複製" swap, generalized (id=435 §二.2)
// for any icon-only row action. onActivate does the actual work; returning
// true/false triggers the copied/failed tooltip swap, returning undefined
// (pure navigation, no clipboard involved) leaves the tooltip alone.
function buildIconAction({ icon, label, className = 'copy-icon-btn', onActivate }) {
  const tooltip = el('span', { class: 'copy-tooltip', 'aria-hidden': 'true', text: label })
  const btn = el('button', { class: className, type: 'button', 'aria-label': label }, [icon, tooltip])

  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    const result = await onActivate(e)
    if (result === undefined) return
    tooltip.textContent = result ? '已複製' : '複製失敗'
    btn.setAttribute('aria-label', result ? '已複製' : '複製失敗')
    tooltip.classList.add('force-visible')
    btn.classList.toggle('copied', result)
    setTimeout(() => {
      tooltip.classList.remove('force-visible')
      tooltip.textContent = label
      btn.setAttribute('aria-label', label)
      btn.classList.remove('copied')
    }, 1400)
  })

  return btn
}

// id=435 §二: replaces the old "⋯" popover menu with 3 always-visible icons.
// 複製連結/複製內文 stay grouped (both copy actions); 開啟詳情 gets a hairline
// divider (.row-icon-nav) to mark it as the different, navigational kind.
// id=435 §三.4 (Human feedback after §二 shipped): 複製連結 reverted from a
// bare URL back to the full id=427 "複製引用" format (id+title+url) — a bare
// link pasted into a chat had no context to identify which note it was.
// This deliberately makes 複製連結 and the detail panel's "複製引用" button
// the same action again; buildNoteLink() is kept only as buildReferenceText's
// internal URL piece, not called directly from here anymore.
function buildRowActionIcons(note) {
  const copyLinkBtn = buildIconAction({
    icon: iconLink(),
    label: '複製連結',
    onActivate: async () => {
      try {
        await copyToClipboard(buildReferenceText(note))
        return true
      } catch {
        return false
      }
    },
  })
  const copyContentBtn = buildIconAction({
    icon: iconCopy(),
    label: '複製內文',
    onActivate: async () => {
      try {
        await copyToClipboard(note.content)
        return true
      } catch {
        return false
      }
    },
  })
  const openDetailBtn = buildIconAction({
    icon: iconChevronRight(),
    label: '開啟詳情',
    className: 'copy-icon-btn row-icon-nav',
    onActivate: () => {
      navigateToNote(note.id)
    },
  })
  // id=440 §一.1: primary reply entry point at the row level. Placed after
  // 開啟詳情 (not grouped with the two copy actions) since it's a
  // do-something-new action, not a copy — no ordering was specified in the
  // spec, this is CC's call.
  const replyBtn = buildIconAction({
    icon: iconReply(),
    label: '回覆',
    className: 'copy-icon-btn row-icon-nav',
    onActivate: () => {
      if (composeFormRef) composeFormRef.startReply(note)
    },
  })
  return el('div', { class: 'row-actions' }, [copyLinkBtn, copyContentBtn, openDetailBtn, replyBtn])
}

// --- copy-reference (id=427 §二): id + short title + deep link, never the
// full note content, so a paste into a chat can't leak sensitive content. ---
// Only caller left is the detail panel's own "複製引用" button (id=435 §二
// removed the row-level one — see buildRowActionIcons' comment), which
// wants both the toast AND its own inline "已複製" swap.
async function performCopy(note) {
  if (copyInFlight) return false
  copyInFlight = true
  setTimeout(() => {
    copyInFlight = false
  }, 600)
  try {
    await copyToClipboard(buildReferenceText(note))
    showToast('已複製白板引用')
    return true
  } catch (err) {
    showToast(friendlyErrorMessage(err))
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
        if (statusTabsRef) statusTabsRef.reload()
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

// id=441 §1.2/§三: title excerpt cap and 4-color semantic, shared by every
// node the sidebar renders (ancestors, current note, direct children).
// truncateForNode picks the midpoint of the spec's suggested 20–30 char
// range, same "range given, CC picks the middle" precedent as
// footballPreview.js's 90-char cap.
function truncateForNode(text, max = 26) {
  const t = text || ''
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t
}

// Green wins regardless of leaf-ness (archived/extracted is done even if
// nothing ever replied to it); amber is reserved for a genuinely still-open
// leaf; everything else (has children, or unresolved-but-superseded by a
// reply) is gray. `knownHasChildren` covers nodes whose child relationship
// the caller already knows for certain from the trail/direct-children data
// itself (independent of the capped tree-scan), so a node never gets
// mis-colored amber just because the scan happened to stop before
// recording its child — see loadReplyContext.
function flowColor(note, childrenOf, knownHasChildren) {
  if (note.status === 'archived' || note.status === 'extracted') return 'green'
  const hasChildren = (childrenOf.get(note.id) || []).length > 0 || (knownHasChildren && knownHasChildren.has(note.id))
  if (!hasChildren && (note.status === 'raw' || note.status === 'triaged')) return 'amber'
  return 'gray'
}

// id=441 §7.1: applied uniformly to both the pending-leaf list AND the
// single-leaf "目前球在 X" case — the spec's own wording only mentions the
// list ("清單中"), but the same NULL-recipient gap can equally occur for a
// single pending leaf, so this reuses the same fallback text there too.
function recipientOrUnassigned(note) {
  return note.recipient ? recipientLabel(note.recipient) : '此節點尚未指定收件人'
}

// id=441 §1.2/§1.4: one node renderer reused for ancestors, the current
// note, and direct children. buildIconAction's own click handler already
// calls stopPropagation before running onActivate, so the copy button never
// also triggers the node's own navigate-on-click.
function buildFlowNode(note, { color, isCurrent, hint } = {}) {
  const copyBtn = buildIconAction({
    icon: iconLink(),
    label: '複製引用',
    onActivate: async () => {
      try {
        await copyToClipboard(buildReferenceText(note))
        return true
      } catch {
        return false
      }
    },
  })
  const bodyChildren = [
    el('div', { class: 'flow-node-line1' }, [
      el('span', { class: 'flow-node-id', text: '#' + note.id }),
      el('span', { class: 'flow-node-recipient', text: recipientOrUnassigned(note) }),
      el('span', { class: 'flow-node-status', text: statusLabel(note.status) }),
    ]),
    el('div', { class: 'flow-node-line2' }, [
      el('span', { class: 'flow-node-title', text: truncateForNode(noteTitleOrExcerpt(note)) }),
      el('span', { class: 'flow-node-time', text: new Date(note.created_at).toLocaleString() }),
    ]),
  ]
  // §7.2's muted "deeper replies exist" note belongs inside the body so it
  // stacks under line1/line2 — appending it as a sibling of body/copyBtn
  // would make it a 3rd item in the node's flex row instead.
  if (hint) bodyChildren.push(el('p', { class: 'flow-node-hint', text: hint }))
  const body = el('div', { class: 'flow-node-body' }, bodyChildren)
  const classes = ['flow-node', 'flow-node-' + (color || 'gray')]
  if (isCurrent) classes.push('flow-node-current')
  const nodeProps = { class: classes.join(' ') }
  if (!isCurrent) {
    nodeProps.role = 'button'
    nodeProps.tabindex = '0'
  }
  const node = el('div', nodeProps, [body, copyBtn])
  if (!isCurrent) {
    node.addEventListener('click', () => navigateToNote(note.id))
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        navigateToNote(note.id)
      }
    })
  }
  return node
}

// id=441 P0: "回覆脈絡" sidebar — parent trail up to root, the current
// note, and direct children only (§7.2 supersedes the original §1.1's
// "遞迴列出所有子孫": a direct child with its own further replies gets a
// muted note instead of auto-expanding, since a full recursive tree is
// P1 task-tree modal territory, not this sidebar's). Pending-leaf
// detection (§1.3) is unmodified by §七 and still scans the whole tree —
// via bounded iterative fetches (§7.3: no recursive CTE, no new RPC), not
// just whatever happens to be on-screen — so "N 條分支待處理" never
// understates branches outside the visible trail/children.
async function loadReplyContext(note, container) {
  container.replaceChildren(el('p', { class: 'flow-loading', text: '載入回覆脈絡…' }))

  // GPT #120 code review (id=441 follow-up): a query failure here must
  // never be mistaken for "genuinely no data" — that's exactly the
  // "lost ball" failure mode this whole feature exists to prevent. Each
  // fetch gets its own explicit failed-flag instead of silently
  // defaulting to an empty result indistinguishable from a real empty
  // state.
  let trail = []
  let upAnomaly = null
  let trailLoadFailed = false
  try {
    ;({ trail, anomaly: upAnomaly } = await getReplyTrailUp(note))
  } catch {
    trailLoadFailed = true
  }

  let directChildren = []
  let directChildrenLoadFailed = false
  try {
    directChildren = await listReplies(note.id)
  } catch {
    directChildrenLoadFailed = true
  }

  // id=440 §2's isolated-note case still applies unchanged: no parent, no
  // replies at all, nothing upstream we couldn't reach either — but only
  // once we actually know that for certain. A failed fetch defaulting to
  // an empty array must not be read as "confirmed empty".
  if (!trailLoadFailed && !directChildrenLoadFailed && !note.reply_to_note_id && trail.length === 0 && directChildren.length === 0 && !upAnomaly) {
    container.replaceChildren(
      el('div', { class: 'reply-context' }, [
        el('p', { class: 'flow-empty-message', text: '此 note 尚未連入結構化回覆串' }),
        el('button', {
          type: 'button',
          class: 'flow-empty-copy-btn',
          text: '複製引用以建立回覆',
          onclick: () => performCopy(note),
        }),
      ])
    )
    return
  }

  const rootId = trail.length ? trail[0].id : note.id
  let nodesById = new Map()
  let childrenOf = new Map()
  let truncated = false
  let treeScanFailed = false
  try {
    ;({ nodesById, childrenOf, truncated } = await scanReplyTree(rootId))
  } catch {
    treeScanFailed = true
  }

  // Child relationships we already know for certain from the trail/direct-
  // children fetches themselves, independent of whether the capped tree-
  // scan happened to reach them — passed into flowColor so an ancestor or
  // the current note is never mis-colored amber just because the scan
  // stopped short of recording its (already-known) child.
  const knownHasChildren = new Set()
  for (let i = 0; i < trail.length - 1; i++) knownHasChildren.add(trail[i].id)
  if (trail.length) knownHasChildren.add(trail[trail.length - 1].id)
  if (directChildren.length) knownHasChildren.add(note.id)

  const sections = []

  if (trailLoadFailed) {
    sections.push(el('p', { class: 'flow-exception', text: '無法載入上游回覆脈絡，請稍後再試' }))
  } else if (upAnomaly === 'parent_unavailable') {
    sections.push(el('p', { class: 'flow-exception', text: '上游 note 已刪除或不可見' }))
  } else if (upAnomaly === 'cycle' || upAnomaly === 'depth_exceeded') {
    sections.push(el('p', { class: 'flow-exception', text: '偵測到回覆鏈異常' }))
  }

  if (trail.length) {
    const trailEl = el('div', { class: 'flow-trail' })
    trail.forEach((ancestor) => {
      trailEl.appendChild(buildFlowNode(ancestor, { color: flowColor(ancestor, childrenOf, knownHasChildren) }))
      trailEl.appendChild(el('div', { class: 'flow-connector', 'aria-hidden': 'true', text: '↓' }))
    })
    sections.push(trailEl)
  }

  sections.push(buildFlowNode(note, { color: flowColor(note, childrenOf, knownHasChildren), isCurrent: true }))

  if (directChildrenLoadFailed) {
    sections.push(el('p', { class: 'flow-exception', text: '無法載入後續回覆，請稍後再試' }))
  } else if (directChildren.length) {
    const childrenEl = el('div', { class: 'flow-children' }, [
      el('p', { class: 'flow-children-heading', text: `此 note 有 ${directChildren.length} 則後續回覆` }),
    ])
    directChildren.forEach((child) => {
      const hasMore = (childrenOf.get(child.id) || []).length > 0
      // §7.2: a direct child's own further replies stay collapsed here — a
      // muted, non-interactive note instead of a dead link, since P1's
      // task-tree modal (where this would actually go) doesn't exist yet.
      const hint = hasMore ? '此分支還有更深層回覆（任務樹功能開發中）' : null
      childrenEl.appendChild(buildFlowNode(child, { color: flowColor(child, childrenOf), hint }))
    })
    sections.push(childrenEl)
  }

  if (truncated) {
    sections.push(el('p', { class: 'flow-exception', text: '回覆鏈過大，請開完整任務樹' }))
  }

  // GPT #124 (2nd review, residual edge case): trailLoadFailed also
  // invalidates the pending summary, not just treeScanFailed. When the
  // upward walk fails, rootId falls back to note.id (its own subtree),
  // so even a *successful* scan from there only ever covers the current
  // note's local branch — upstream siblings we never reached could still
  // have a pending leaf. "0 pending" would be a real claim about the
  // whole chain, which we can't make with only a partial view of it.
  if (trailLoadFailed || treeScanFailed) {
    // Never fall through to "0 pending leaves" here — an empty nodesById
    // from a failed scan is indistinguishable from a genuinely fully-
    // resolved chain unless this is called out explicitly.
    sections.push(el('p', { class: 'flow-exception', text: '無法完整載入回覆鏈，待處理摘要暫不可用' }))
  } else {
    const pendingLeaves = findPendingLeaves(nodesById, childrenOf)
    if (pendingLeaves.length === 1) {
      const label = recipientOrUnassigned(pendingLeaves[0])
      sections.push(el('p', { class: 'flow-pending flow-pending-single', text: `🟡 目前球在 ${label}` }))
    } else if (pendingLeaves.length > 1) {
      sections.push(
        el('div', { class: 'flow-pending flow-pending-multi' }, [
          el('p', { class: 'flow-pending-heading', text: `🟡 目前有 ${pendingLeaves.length} 條分支待處理` }),
          el(
            'ul',
            {},
            pendingLeaves.map((n) =>
              el('li', { text: `#${n.id}　${recipientOrUnassigned(n)}　${statusLabel(n.status)}` + (n.id === note.id ? '（本則）' : '') })
            )
          ),
        ])
      )
    } else {
      sections.push(el('p', { class: 'flow-pending flow-pending-done', text: '✅ 此任務鏈已無待處理項目' }))
    }
  }

  container.replaceChildren(el('div', { class: 'reply-context' }, sections))
}

function renderDetailNote(note, { foundInList } = {}) {
  let editing = false

  // id=440 §一.1: 詳情頁's own reply entry point — same startReply() as the
  // row-level icon, just triggered from here instead.
  const replyBtn = el(
    'button',
    { class: 'reply-btn', type: 'button', onclick: () => composeFormRef && composeFormRef.startReply(note) },
    [iconReply(), el('span', { text: '回覆' })]
  )

  const copyBtnLabel = el('span', { text: '複製引用' })
  const copyBtn = el('button', { class: 'copy-ref-btn', type: 'button', 'aria-label': '複製白板引用' }, [iconLink(), copyBtnLabel])
  copyBtn.addEventListener('click', async () => {
    const ok = await performCopy(note)
    if (ok) {
      copyBtn.classList.add('copied')
      copyBtnLabel.textContent = '已複製'
      setTimeout(() => {
        copyBtn.classList.remove('copied')
        copyBtnLabel.textContent = '複製引用'
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
        if (statusTabsRef) statusTabsRef.reload()
        showToast('已移到垃圾桶', {
          actionLabel: '復原',
          onAction: async () => {
            try {
              await restoreNote(note.id)
              if (listMountEl) refreshList(listMountEl)
              if (statusTabsRef) statusTabsRef.reload()
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
        if (statusTabsRef) statusTabsRef.reload()
      } catch (err) {
        showToast(friendlyErrorMessage(err))
      }
    })

    const notInFilterNotice = foundInList === false ? el('p', { class: 'detail-message', text: '此 note 不在目前篩選結果。' }) : el('div')

    // id=431§十二: reuse the existing row-expand attachments component,
    // just mounted into the detail panel instead. renderDetailNote is only
    // ever called for a non-trashed note (syncDetailFromHash routes
    // deleted_at notes to renderDetailTrashMessage before reaching here),
    // so no isTrashed guard is needed the way the row-expand call site has.
    // Loaded eagerly (not on a lazy expand toggle) — the detail panel has
    // no collapsed state, opening it already is the "expanded" action.
    const attachments = buildAttachmentsSection(note, { hideWhenEmpty: true })
    attachments.load()

    const tagsEl = tags.length
      ? el(
          'div',
          { class: 'note-tags' },
          tags.map((t) => el('span', { class: 'note-tag-pill', text: '#' + displayTag(t) }))
        )
      : el('p', { class: 'tag-empty-hint', text: '尚未加入標籤。加入 1–3 個你未來可能用來搜尋這則 note 的主題詞。' })

    // id=441 P0: "回覆脈絡" sidebar section — supersedes id=440 §2's minimal
    // one-level backward/forward links (this extends that same query
    // layer with the full parent trail + pending-leaf summary). Loaded
    // async, mount starts with a loading message so there's no flash of
    // empty content.
    const replyContextMount = el('div', { class: 'reply-context-mount' })
    loadReplyContext(note, replyContextMount)

    return el('div', {}, [
      notInFilterNotice,
      el('pre', { class: 'detail-content', text: note.content }),
      attachments.element,
      tagsEl,
      el('h3', { class: 'reply-context-heading', text: '回覆脈絡' }),
      replyContextMount,
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

    // id=440 §1.2: editing an existing note's reply target, self-excluded
    // (excludeId: note.id) so it can't be set to reply to itself. Shows a
    // placeholder "#N" immediately (never nothing — the raw id is a valid,
    // if unfriendly, identifier while the real title loads), then swaps in
    // the resolved title once the async lookup returns.
    let replyTarget = note.reply_to_note_id ? { id: note.reply_to_note_id, label: '#' + note.reply_to_note_id } : null
    const replyChip = buildReplyChip(() => {
      replyTarget = null
      replyChip.render(null)
      scheduleSave()
    })
    replyChip.render(replyTarget)
    if (replyTarget) {
      const targetId = replyTarget.id
      getNoteById(targetId)
        .then((n) => {
          if (n && replyTarget && replyTarget.id === targetId) {
            replyTarget = { id: n.id, label: noteTitleOrExcerpt(n) }
            replyChip.render(replyTarget)
          }
        })
        .catch(() => {})
    }
    const replySearch = buildReplySearchField({
      excludeId: note.id,
      onSelect: (n) => {
        replyTarget = { id: n.id, label: noteTitleOrExcerpt(n) }
        replyChip.render(replyTarget)
        scheduleSave()
      },
    })

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
        replyToNoteId: replyTarget ? replyTarget.id : null,
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
          reply_to_note_id: fields.replyToNoteId,
          updated_at: new Date().toISOString(),
        })
        saveStatusEl.textContent = '已儲存'
        invalidateTagStats()
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
      el('label', { class: 'field-label' }, [el('span', { text: '收' }), recipientSelect]),
      tagField(tagEditor, { label: '標籤' }),
      el('label', { class: 'field-label' }, [el('span', { text: '回覆對象（選填）' }), replyChip.element, replySearch]),
      saveStatusEl,
    ])
  }

  draw()

  renderDetailShell(
    [
      el('div', { class: 'detail-header-actions' }, [copyBtn, replyBtn, editToggleBtn]),
      el('h2', { class: 'detail-title', text: note.title || '(無標題)' }),
      el('div', { class: 'detail-badges' }, [
        el('span', { class: 'badge badge-from' }, [iconUser(), el('span', { text: fromLabel(note.created_by_label) })]),
        note.recipient
          ? el('span', { class: 'badge badge-to-set' }, [iconUser(), el('span', { text: recipientLabel(note.recipient) })])
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
