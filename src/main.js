import { onAuthChange, signInWithGoogle, signOut } from './auth.js'
import { PROJECT_KEYS, SOURCE_TYPES, STATUSES, listNotes, createNote, updateStatus, softDelete } from './whiteboard.js'

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
let filters = { projectKey: '', status: '', tag: '' }

function render() {
  app.replaceChildren()
  app.appendChild(currentSession ? renderBoard() : renderLogin())
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
  const listCol = el('div', { class: 'list-col' }, [renderFilters(listMount), listMount])
  const formCol = el('div', { class: 'form-col' }, [renderNoteForm()])

  container.appendChild(el('div', { class: 'board-grid' }, [formCol, listCol]))

  refreshList(listMount)

  return container
}

function renderNoteForm() {
  const titleInput = el('input', { type: 'text', placeholder: '標題（選填）' })
  const contentInput = el('textarea', {
    placeholder: '內容（純文字）',
    rows: '5',
  })
  const projectSelect = el('select', {}, PROJECT_KEYS.map((k) => option(k, k)))
  const sourceSelect = el('select', {}, SOURCE_TYPES.map((k) => option(k, k)))
  const tagsInput = el('input', { type: 'text', placeholder: '標籤（逗號分隔）' })

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
      status.textContent = '已新增。'
      const mount = document.querySelector('.list-mount')
      if (mount) refreshList(mount)
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

  const apply = () => {
    filters = { projectKey: projectSelect.value, status: statusSelect.value, tag: tagInput.value.trim() }
    refreshList(listMount)
  }

  projectSelect.addEventListener('change', apply)
  statusSelect.addEventListener('change', apply)
  tagInput.addEventListener('input', apply)

  return el('div', { class: 'filters' }, [projectSelect, statusSelect, tagInput])
}

async function refreshList(mount) {
  mount.replaceChildren(el('p', { text: '載入中…' }))
  try {
    const notes = await listNotes(filters)
    mount.replaceChildren(renderList(notes, mount))
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

  return el('li', { class: 'note-item' }, [
    el('div', { class: 'note-head' }, [
      el('strong', { text: note.title || '(無標題)' }),
      el('span', { class: 'tag-project', text: note.project_key }),
    ]),
    contentWrap,
    tagsText ? el('div', { class: 'note-tags', text: '標籤: ' + tagsText }) : el('div'),
    el('div', { class: 'note-meta', text: '來源: ' + note.source_type + ' ・ ' + new Date(note.created_at).toLocaleString() }),
    el('div', { class: 'note-actions' }, [statusSelect, deleteBtn]),
  ])
}

onAuthChange((session) => {
  currentSession = session
  render()
})
