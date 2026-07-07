import { onAuthChange, signInWithGoogle, signOut } from './auth.js'
import { PROJECT_KEYS, SOURCE_TYPES, STATUSES, listNotes, createNote, updateStatus, softDelete, getNoteById } from './whiteboard.js'
import { loadDraft, saveDraft, clearDraft } from './draft.js'
import { getNoteIdFromHash, navigateToNote, clearNoteHash, onHashChange } from './router.js'
import { buildReferenceText, copyToClipboard } from './copyReference.js'

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

let currentSession = null
let filters = { projectKey: '', status: '', tag: '', trash: false }
let activeNoteId = null
let detailPanelEl = null
let listMountEl = null
let openMenuCloser = null
let copyInFlight = false
let toastTimeoutId = null

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
  const listCol = el('div', { class: 'list-col' }, [renderFilters(listMount), listMount])
  const formCol = el('div', { class: 'form-col' }, [renderNoteForm()])

  container.appendChild(el('div', { class: 'board-grid' }, [formCol, listCol]))

  detailPanelEl = el('aside', { class: 'detail-panel hidden', role: 'dialog', 'aria-label': '便利貼詳情' })
  container.appendChild(detailPanelEl)

  refreshList(listMount)

  return container
}

function renderNoteForm() {
  const titleInput = el('input', { type: 'text', placeholder: '標題（選填）' })
  const contentInput = el('textarea', {
    placeholder: '內容（純文字）',
    rows: '14',
  })
  const projectSelect = el('select', {}, PROJECT_KEYS.map((k) => option(k, k)))
  const sourceSelect = el('select', {}, SOURCE_TYPES.map((k) => option(k, k)))
  const tagsInput = el('input', { type: 'text', placeholder: '標籤（逗號分隔）' })

  // Restore an in-progress draft (reload / navigate away and back).
  const draft = loadDraft()
  if (draft) {
    titleInput.value = draft.title || ''
    contentInput.value = draft.content || ''
    if (PROJECT_KEYS.includes(draft.projectKey)) projectSelect.value = draft.projectKey
    if (SOURCE_TYPES.includes(draft.sourceType)) sourceSelect.value = draft.sourceType
    tagsInput.value = draft.tags || ''
  }

  const persistDraft = () => {
    saveDraft({
      title: titleInput.value,
      content: contentInput.value,
      projectKey: projectSelect.value,
      sourceType: sourceSelect.value,
      tags: tagsInput.value,
    })
  }
  ;[titleInput, contentInput, tagsInput].forEach((input) => input.addEventListener('input', persistDraft))
  ;[projectSelect, sourceSelect].forEach((sel) => sel.addEventListener('change', persistDraft))

  const warning = el('p', {
    class: 'warning',
    text: '⚠️ 請勿貼入病人可辨識資訊(PHI)、密碼、API key/token，或未經授權的受版權內容。',
  })

  const status = el('p', { class: 'form-status' })

  const submit = async (e) => {
    e.preventDefault()
    status.textContent = ''
    const content = contentInput.value
    if (!content || !content.trim()) {
      status.textContent = '內容不可為空。'
      return
    }
    const tags = tagsInput.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    try {
      await createNote({
        title: titleInput.value.trim(),
        content,
        projectKey: projectSelect.value,
        sourceType: sourceSelect.value,
        tags,
      })
      titleInput.value = ''
      contentInput.value = ''
      tagsInput.value = ''
      clearDraft()
      status.textContent = '已新增。'
      if (listMountEl) refreshList(listMountEl)
    } catch (err) {
      status.textContent = '新增失敗：' + err.message
    }
  }

  const form = el('form', { class: 'note-form', onsubmit: submit }, [
    el('h2', { text: '貼上筆記' }),
    warning,
    titleInput,
    contentInput,
    el('div', { class: 'row' }, [projectSelect, sourceSelect, tagsInput]),
    el('button', { type: 'submit', text: '新增' }),
    status,
  ])

  return form
}

function renderFilters(listMount) {
  const projectSelect = el('select', {}, [option('', '全部專案'), ...PROJECT_KEYS.map((k) => option(k, k))])
  const statusSelect = el('select', {}, [option('', '全部狀態'), ...STATUSES.map((k) => option(k, k)), option('extracted', 'extracted')])
  const tagInput = el('input', { type: 'text', placeholder: '依標籤篩選' })
  const trashToggle = el('button', {
    type: 'button',
    class: 'trash-toggle',
    text: filters.trash ? '返回白板' : '垃圾桶',
  })

  const apply = () => {
    filters = { ...filters, projectKey: projectSelect.value, status: statusSelect.value, tag: tagInput.value.trim() }
    refreshList(listMount)
  }

  projectSelect.addEventListener('change', apply)
  statusSelect.addEventListener('change', apply)
  tagInput.addEventListener('input', apply)
  trashToggle.addEventListener('click', () => {
    filters = { ...filters, trash: !filters.trash }
    trashToggle.textContent = filters.trash ? '返回白板' : '垃圾桶'
    refreshList(listMount)
  })

  return el('div', { class: 'filters' }, [projectSelect, statusSelect, tagInput, trashToggle])
}

async function refreshList(mount) {
  mount.replaceChildren(el('p', { text: '載入中…' }))
  try {
    const notes = await listNotes(filters)
    mount.replaceChildren(renderList(notes, mount))
    applyHighlight()
  } catch (err) {
    mount.replaceChildren(el('p', { class: 'error', text: '載入失敗：' + err.message }))
  }
}

function renderList(notes, mount) {
  if (!notes.length) {
    return el('p', { text: '目前沒有符合條件的筆記。' })
  }

  const items = notes.map((note) => renderNote(note, mount))
  return el('ul', { class: 'note-list' }, items)
}

function renderNote(note, mount) {
  const statusSelect = el('select', {}, STATUSES.map((s) => option(s, s)))
  statusSelect.value = STATUSES.includes(note.status) ? note.status : STATUSES[0]
  statusSelect.addEventListener('change', async () => {
    try {
      await updateStatus(note.id, statusSelect.value)
      refreshList(mount)
      if (activeNoteId === note.id) syncDetailFromHash()
    } catch (err) {
      alert('更新狀態失敗：' + err.message)
    }
  })

  const deleteBtn = el('button', {
    class: 'delete-btn',
    text: '刪除',
    onclick: async () => {
      if (!confirm('確定刪除這則筆記？')) return
      try {
        await softDelete(note.id)
        refreshList(mount)
        if (activeNoteId === note.id) syncDetailFromHash()
      } catch (err) {
        alert('刪除失敗：' + err.message)
      }
    },
  })

  const tagsText = Array.isArray(note.tags) && note.tags.length ? note.tags.join(', ') : ''

  // textContent only — pasted content is always rendered as plain text, never innerHTML.
  const contentEl = el('pre', { class: 'note-content', text: note.content })
  const contentWrap = el('div', { class: 'note-content-wrap' }, [contentEl])

  const isLong = note.content.length > 320
  if (isLong) {
    const toggleBtn = el('button', {
      class: 'expand-toggle',
      type: 'button',
      text: '展開',
      onclick: () => {
        const expanded = contentWrap.classList.toggle('expanded')
        toggleBtn.textContent = expanded ? '收合' : '展開'
      },
    })
    contentWrap.appendChild(toggleBtn)
  }

  const titleBtn = el('button', {
    class: 'note-title-btn',
    type: 'button',
    text: note.title || '(無標題)',
    onclick: () => navigateToNote(note.id),
  })

  const menu = buildCardMenu(note)

  return el('li', { class: 'note-item', 'data-note-id': String(note.id) }, [
    el('div', { class: 'note-head' }, [titleBtn, el('span', { class: 'tag-project', text: note.project_key }), menu]),
    contentWrap,
    tagsText ? el('div', { class: 'note-tags', text: '標籤: ' + tagsText }) : el('div'),
    el('div', { class: 'note-meta', text: '來源: ' + note.source_type + ' ・ ' + new Date(note.created_at).toLocaleString() }),
    el('div', { class: 'note-actions' }, [statusSelect, deleteBtn]),
  ])
}

function buildCardMenu(note) {
  const wrap = el('div', { class: 'card-menu' })
  const popover = el('div', { class: 'card-menu-popover hidden' })

  const close = () => {
    popover.classList.add('hidden')
    if (openMenuCloser === close) openMenuCloser = null
  }

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
    if (toast) showToast('複製失敗：' + err.message)
    return false
  }
}

function showToast(message) {
  let toastEl = document.querySelector('.wb-toast')
  if (!toastEl) {
    toastEl = el('div', { class: 'wb-toast' })
    document.body.appendChild(toastEl)
  }
  toastEl.textContent = message
  toastEl.classList.add('visible')
  if (toastTimeoutId) clearTimeout(toastTimeoutId)
  toastTimeoutId = setTimeout(() => toastEl.classList.remove('visible'), 1500)
}

// --- deep link (#/note/{id}) + detail panel (id=427 §一) -------------------
function applyHighlight() {
  if (!listMountEl) return
  listMountEl.querySelectorAll('.note-item.highlighted').forEach((n) => n.classList.remove('highlighted'))
  if (activeNoteId == null) return
  const card = listMountEl.querySelector(`.note-item[data-note-id="${activeNoteId}"]`)
  if (card) {
    card.classList.add('highlighted')
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    setTimeout(() => card.classList.remove('highlighted'), 1600)
  }
}

function closeDetailPanel() {
  if (!detailPanelEl) return
  detailPanelEl.classList.add('hidden')
  detailPanelEl.replaceChildren()
}

function renderDetailShell(bodyChildren) {
  if (!detailPanelEl) return
  detailPanelEl.classList.remove('hidden')
  const closeBtn = el('button', {
    class: 'detail-close',
    type: 'button',
    'aria-label': '關閉詳情',
    text: '✕',
    onclick: () => clearNoteHash(),
  })
  detailPanelEl.replaceChildren(el('div', { class: 'detail-head' }, [closeBtn]), ...bodyChildren)
}

function renderDetailLoading() {
  renderDetailShell([el('p', { text: '載入中…' })])
}

// Same message for "doesn't exist" and "not yours" — id=427 §一.7: never
// reveal whether an id exists to someone who can't read it.
function renderDetailMessage(text) {
  renderDetailShell([el('p', { class: 'detail-message', text })])
}

function renderDetailTrashMessage(note) {
  const goTrash = el('button', {
    type: 'button',
    class: 'trash-toggle',
    text: '前往垃圾桶',
    onclick: () => {
      filters = { ...filters, trash: true }
      if (listMountEl) refreshList(listMountEl)
    },
  })
  renderDetailShell([
    el('h2', { class: 'detail-title', text: note.title || '(無標題)' }),
    el('p', { class: 'detail-message', text: '此便利貼位於垃圾桶。' }),
    goTrash,
  ])
}

function renderDetailNote(note) {
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

  const statusSelect = el('select', {}, STATUSES.map((s) => option(s, s)))
  statusSelect.value = STATUSES.includes(note.status) ? note.status : STATUSES[0]
  statusSelect.addEventListener('change', async () => {
    try {
      await updateStatus(note.id, statusSelect.value)
      if (listMountEl) refreshList(listMountEl)
      syncDetailFromHash()
    } catch (err) {
      alert('更新狀態失敗：' + err.message)
    }
  })

  const deleteBtn = el('button', {
    class: 'delete-btn',
    type: 'button',
    text: '刪除',
    onclick: async () => {
      if (!confirm('確定刪除這則筆記？')) return
      try {
        await softDelete(note.id)
        if (listMountEl) refreshList(listMountEl)
        syncDetailFromHash()
      } catch (err) {
        alert('刪除失敗：' + err.message)
      }
    },
  })

  const tagsText = Array.isArray(note.tags) && note.tags.length ? note.tags.join(', ') : ''

  renderDetailShell([
    copyBtn,
    el('h2', { class: 'detail-title', text: note.title || '(無標題)' }),
    el('span', { class: 'tag-project', text: note.project_key }),
    el('pre', { class: 'detail-content', text: note.content }),
    tagsText ? el('div', { class: 'note-tags', text: '標籤: ' + tagsText }) : el('div'),
    el('div', { class: 'note-meta', text: '來源: ' + note.source_type + ' ・ ' + new Date(note.created_at).toLocaleString() }),
    el('div', { class: 'note-actions' }, [statusSelect, deleteBtn]),
  ])
}

async function syncDetailFromHash() {
  if (!currentSession || !detailPanelEl) return
  const id = getNoteIdFromHash()
  activeNoteId = id
  applyHighlight()

  if (id == null) {
    closeDetailPanel()
    return
  }

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
    renderDetailNote(note)
  } catch (err) {
    renderDetailMessage('載入失敗：' + err.message)
  }
}

onHashChange(syncDetailFromHash)

onAuthChange((session) => {
  currentSession = session
  render()
})
