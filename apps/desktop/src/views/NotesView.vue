<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { open, save } from '@tauri-apps/plugin-dialog'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { useRouter } from 'vue-router'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TurndownService from 'turndown'
import {
  Bold,
  ArrowLeft,
  Braces,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Download,
  FileJson,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Import,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  NotebookPen,
  Pin,
  PinOff,
  Plus,
  Quote,
  Redo2,
  Search,
  Strikethrough,
  Trash2,
  Underline,
  Undo2,
  Unlink,
  X
} from 'lucide-vue-next'
import {
  createNote,
  deleteNote,
  duplicateNote,
  exportNotes,
  getNote,
  importNotes,
  listNotes,
  saveNote,
  setNotePinned,
  writeNoteExport,
  type NoteRecord,
  type NoteSummary
} from '../services/notes'
import UiConfirmDialog from '../components/ui/UiConfirmDialog.vue'

type ExportFormat = 'markdown' | 'html' | 'json'

const router = useRouter()
const notes = ref<NoteSummary[]>([])
const selectedNote = ref<NoteRecord | null>(null)
const title = ref('')
const contentText = ref('')
const query = ref('')
const loading = ref(true)
const saving = ref(false)
const dirty = ref(false)
const saveStatus = ref('')
const error = ref('')
const message = ref('')
const deleteDialogOpen = ref(false)
const exportMenuOpen = ref(false)
let hydrating = false
let saveTimer = 0
let searchTimer = 0
let messageTimer = 0
let activeSave: Promise<boolean> | null = null

const editor = useEditor({
  content: '<p></p>',
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' }
    }),
    Placeholder.configure({ placeholder: '输入正文，或使用工具栏开始排版...' })
  ],
  editorProps: {
    attributes: {
      class: 'note-prose-editor',
      spellcheck: 'true'
    }
  },
  onUpdate: ({ editor: currentEditor }) => {
    contentText.value = currentEditor.getText({ blockSeparator: '\n' })
    scheduleSave()
  }
})

const wordCount = computed(() => contentText.value.replace(/\s/g, '').length)

function showMessage(value: string) {
  message.value = value
  window.clearTimeout(messageTimer)
  messageTimer = window.setTimeout(() => {
    message.value = ''
  }, 3200)
}

function describeError(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

async function loadNotes() {
  error.value = ''
  try {
    notes.value = await listNotes(query.value)
  } catch (cause) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

async function selectNote(noteId: string) {
  if (selectedNote.value?.id === noteId) return
  await persistCurrentNote()
  error.value = ''
  try {
    const note = await getNote(noteId)
    if (!note) throw new Error('笔记不存在或已被删除')
    hydrating = true
    selectedNote.value = note
    title.value = note.title
    contentText.value = note.contentText
    editor.value?.commands.setContent(note.contentHtml || '<p></p>', { emitUpdate: false })
    dirty.value = false
    saveStatus.value = '已保存'
    await nextTick()
    hydrating = false
  } catch (cause) {
    hydrating = false
    error.value = describeError(cause)
  }
}

function scheduleSave() {
  if (hydrating || !selectedNote.value) return
  dirty.value = true
  saveStatus.value = '未保存'
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    void persistCurrentNote()
  }, 700)
}

async function persistCurrentNote() {
  window.clearTimeout(saveTimer)
  if (activeSave) {
    const previousSucceeded = await activeSave
    if (previousSucceeded && dirty.value) await persistCurrentNote()
    return
  }
  if (!dirty.value || !selectedNote.value || !editor.value) return
  const noteId = selectedNote.value.id
  const snapshotTitle = title.value
  const snapshotHtml = editor.value.getHTML()
  const snapshotText = editor.value.getText({ blockSeparator: '\n' })
  const snapshotPinned = selectedNote.value.isPinned
  dirty.value = false
  saving.value = true
  saveStatus.value = '保存中'
  activeSave = (async () => {
    try {
      const saved = await saveNote({
        id: noteId,
        title: snapshotTitle,
        contentHtml: snapshotHtml,
        contentText: snapshotText,
        isPinned: snapshotPinned
      })
      if (selectedNote.value?.id === noteId && !dirty.value) {
        selectedNote.value = saved
        hydrating = true
        title.value = saved.title
        hydrating = false
        saveStatus.value = '已保存'
      }
      await loadNotes()
      return true
    } catch (cause) {
      dirty.value = true
      saveStatus.value = '保存失败'
      error.value = describeError(cause)
      return false
    } finally {
      saving.value = false
    }
  })()
  const succeeded = await activeSave
  activeSave = null
  if (succeeded && dirty.value && selectedNote.value?.id === noteId) await persistCurrentNote()
}

async function addNote() {
  await persistCurrentNote()
  error.value = ''
  try {
    const note = await createNote()
    await loadNotes()
    await selectNote(note.id)
    await nextTick()
    document.querySelector<HTMLInputElement>('.note-title-input')?.select()
  } catch (cause) {
    error.value = describeError(cause)
  }
}

async function removeCurrentNote() {
  const note = selectedNote.value
  if (!note) return
  deleteDialogOpen.value = false
  window.clearTimeout(saveTimer)
  dirty.value = false
  try {
    await deleteNote(note.id)
    selectedNote.value = null
    title.value = ''
    contentText.value = ''
    editor.value?.commands.clearContent(false)
    await loadNotes()
    if (notes.value[0]) await selectNote(notes.value[0].id)
    showMessage('笔记已删除')
  } catch (cause) {
    error.value = describeError(cause)
  }
}

async function copyCurrentNote() {
  if (!selectedNote.value) return
  await persistCurrentNote()
  try {
    const copy = await duplicateNote(selectedNote.value.id)
    await loadNotes()
    await selectNote(copy.id)
    showMessage('已创建笔记副本')
  } catch (cause) {
    error.value = describeError(cause)
  }
}

async function togglePinned() {
  if (!selectedNote.value) return
  const next = !selectedNote.value.isPinned
  try {
    await setNotePinned(selectedNote.value.id, next)
    selectedNote.value = { ...selectedNote.value, isPinned: next }
    await loadNotes()
    showMessage(next ? '笔记已置顶' : '已取消置顶')
  } catch (cause) {
    error.value = describeError(cause)
  }
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '-').trim() || '无标题笔记'
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[character] || character)
}

function exportContent(note: NoteRecord, format: ExportFormat) {
  if (format === 'json') return JSON.stringify(note, null, 2)
  if (format === 'html') {
    return `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(note.title)}</title>\n<style>body{max-width:760px;margin:48px auto;padding:0 24px;color:#24302d;font:16px/1.8 system-ui,sans-serif}h1,h2,h3{line-height:1.35}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #8aa39a;color:#52605a}pre{padding:16px;overflow:auto;background:#f2f4f1}</style>\n</head>\n<body>\n<h1>${escapeHtml(note.title)}</h1>\n${note.contentHtml}\n</body>\n</html>\n`
  }
  const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' })
  return `# ${note.title}\n\n${turndown.turndown(note.contentHtml)}\n`
}

async function exportCurrentNote(format: ExportFormat) {
  if (!selectedNote.value) return
  exportMenuOpen.value = false
  await persistCurrentNote()
  const note = await getNote(selectedNote.value.id)
  if (!note) return
  const extension = format === 'markdown' ? 'md' : format
  const targetPath = await save({
    title: `导出${format === 'markdown' ? ' Markdown' : format.toUpperCase()}`,
    defaultPath: `${safeFileName(note.title)}.${extension}`,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
  })
  if (!targetPath) return
  try {
    await writeNoteExport(targetPath, exportContent(note, format))
    showMessage(`已导出到 ${targetPath}`)
  } catch (cause) {
    error.value = describeError(cause)
  }
}

async function exportAllNotes() {
  await persistCurrentNote()
  const targetPath = await save({
    title: '导出全部笔记',
    defaultPath: `NovelLibrary-notes-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (!targetPath) return
  try {
    const result = await exportNotes(targetPath)
    showMessage(`已导出 ${result.notes} 篇笔记`)
  } catch (cause) {
    error.value = describeError(cause)
  }
}

async function importAllNotes() {
  const sourcePath = await open({
    title: '导入本地笔记',
    multiple: false,
    directory: false,
    filters: [{ name: 'NovelLibrary 笔记', extensions: ['json'] }]
  })
  if (!sourcePath || Array.isArray(sourcePath)) return
  try {
    const result = await importNotes(sourcePath)
    await loadNotes()
    if (!selectedNote.value && notes.value[0]) await selectNote(notes.value[0].id)
    showMessage(`已导入 ${result.notes} 篇笔记`)
  } catch (cause) {
    error.value = describeError(cause)
  }
}

function editLink() {
  if (!editor.value) return
  const current = editor.value.getAttributes('link').href as string | undefined
  const href = window.prompt('输入链接地址', current || 'https://')
  if (href === null) return
  if (!href.trim()) {
    editor.value.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }
  editor.value.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run()
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

watch(title, scheduleSave)
watch(query, () => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => void loadNotes(), 240)
})

onMounted(async () => {
  await loadNotes()
  if (notes.value[0]) await selectNote(notes.value[0].id)
})

onBeforeUnmount(() => {
  window.clearTimeout(saveTimer)
  window.clearTimeout(searchTimer)
  window.clearTimeout(messageTimer)
  void persistCurrentNote()
})
</script>

<template>
  <section class="notes-workspace">
    <section class="note-index" aria-label="笔记列表">
      <header>
        <div class="note-index-heading"><button type="button" class="icon-button" title="返回工具库" @click="router.push('/tools')"><ArrowLeft :size="16" /></button><strong>本地笔记</strong><span>{{ notes.length }}</span></div>
        <div class="note-index-actions">
          <button type="button" class="icon-button" title="导入笔记 JSON" @click="importAllNotes"><Import :size="15" /></button>
          <button type="button" class="icon-button" title="导出全部笔记 JSON" @click="exportAllNotes"><FileJson :size="15" /></button>
          <button type="button" class="icon-button primary-icon" title="新建笔记" @click="addNote"><Plus :size="17" /></button>
        </div>
      </header>
      <label class="note-search"><Search :size="15" /><input v-model="query" placeholder="搜索笔记" /><button v-if="query" type="button" title="清空搜索" @click="query = ''"><X :size="14" /></button></label>
      <div v-if="loading" class="note-list-status">正在读取...</div>
      <div v-else-if="!notes.length" class="note-list-status">暂无笔记</div>
      <div v-else class="note-list">
        <button v-for="note in notes" :key="note.id" type="button" :class="{ active: selectedNote?.id === note.id }" @click="selectNote(note.id)">
          <span><strong>{{ note.title }}</strong><Pin v-if="note.isPinned" :size="12" /></span>
          <p>{{ note.excerpt || '空白笔记' }}</p>
          <time>{{ formatDate(note.updatedAt) }}</time>
        </button>
      </div>
    </section>

    <section class="note-editor-pane">
      <div v-if="error" class="note-editor-alert" role="alert">{{ error }}</div>
      <div v-if="message" class="note-editor-toast" role="status"><Check :size="15" />{{ message }}</div>
      <div v-if="!selectedNote" class="note-editor-empty">
        <NotebookPen :size="34" />
        <h2>新建一篇本地笔记</h2>
        <button type="button" class="primary-command" @click="addNote"><Plus :size="16" />新建笔记</button>
      </div>
      <template v-else>
        <header class="note-editor-commandbar">
          <span :class="{ saving, error: saveStatus === '保存失败' }">{{ saveStatus || '已保存' }}</span>
          <div>
            <button type="button" class="icon-button" :title="selectedNote.isPinned ? '取消置顶' : '置顶笔记'" @click="togglePinned"><PinOff v-if="selectedNote.isPinned" :size="16" /><Pin v-else :size="16" /></button>
            <button type="button" class="icon-button" title="创建副本" @click="copyCurrentNote"><Copy :size="16" /></button>
            <div class="note-export-control">
              <button type="button" class="secondary-command" @click="exportMenuOpen = !exportMenuOpen"><Download :size="15" />导出<ChevronDown :size="14" /></button>
              <div v-if="exportMenuOpen" class="note-export-menu">
                <button type="button" @click="exportCurrentNote('markdown')"><FileText :size="15" />Markdown</button>
                <button type="button" @click="exportCurrentNote('html')"><Braces :size="15" />HTML</button>
                <button type="button" @click="exportCurrentNote('json')"><FileJson :size="15" />JSON</button>
              </div>
            </div>
            <button type="button" class="icon-button danger-icon" title="删除笔记" @click="deleteDialogOpen = true"><Trash2 :size="16" /></button>
          </div>
        </header>

        <div class="note-title-block">
          <input v-model="title" class="note-title-input" maxlength="160" placeholder="无标题笔记" />
          <div><span>{{ wordCount.toLocaleString() }} 字</span><span>创建于 {{ formatDate(selectedNote.createdAt) }}</span></div>
        </div>

        <div v-if="editor" class="note-format-toolbar" role="toolbar" aria-label="笔记格式">
          <button type="button" title="撤销" :disabled="!editor.can().chain().focus().undo().run()" @click="editor.chain().focus().undo().run()"><Undo2 :size="16" /></button>
          <button type="button" title="重做" :disabled="!editor.can().chain().focus().redo().run()" @click="editor.chain().focus().redo().run()"><Redo2 :size="16" /></button>
          <i />
          <button type="button" title="一级标题" :class="{ active: editor.isActive('heading', { level: 1 }) }" @click="editor.chain().focus().toggleHeading({ level: 1 }).run()"><Heading1 :size="17" /></button>
          <button type="button" title="二级标题" :class="{ active: editor.isActive('heading', { level: 2 }) }" @click="editor.chain().focus().toggleHeading({ level: 2 }).run()"><Heading2 :size="17" /></button>
          <button type="button" title="三级标题" :class="{ active: editor.isActive('heading', { level: 3 }) }" @click="editor.chain().focus().toggleHeading({ level: 3 }).run()"><Heading3 :size="17" /></button>
          <i />
          <button type="button" title="加粗" :class="{ active: editor.isActive('bold') }" @click="editor.chain().focus().toggleBold().run()"><Bold :size="16" /></button>
          <button type="button" title="斜体" :class="{ active: editor.isActive('italic') }" @click="editor.chain().focus().toggleItalic().run()"><Italic :size="16" /></button>
          <button type="button" title="下划线" :class="{ active: editor.isActive('underline') }" @click="editor.chain().focus().toggleUnderline().run()"><Underline :size="16" /></button>
          <button type="button" title="删除线" :class="{ active: editor.isActive('strike') }" @click="editor.chain().focus().toggleStrike().run()"><Strikethrough :size="16" /></button>
          <i />
          <button type="button" title="无序列表" :class="{ active: editor.isActive('bulletList') }" @click="editor.chain().focus().toggleBulletList().run()"><List :size="17" /></button>
          <button type="button" title="有序列表" :class="{ active: editor.isActive('orderedList') }" @click="editor.chain().focus().toggleOrderedList().run()"><ListOrdered :size="17" /></button>
          <button type="button" title="引用" :class="{ active: editor.isActive('blockquote') }" @click="editor.chain().focus().toggleBlockquote().run()"><Quote :size="16" /></button>
          <button type="button" title="代码块" :class="{ active: editor.isActive('codeBlock') }" @click="editor.chain().focus().toggleCodeBlock().run()"><Code2 :size="16" /></button>
          <button type="button" title="分隔线" @click="editor.chain().focus().setHorizontalRule().run()"><Minus :size="17" /></button>
          <i />
          <button type="button" title="添加或编辑链接" :class="{ active: editor.isActive('link') }" @click="editLink"><Link2 :size="16" /></button>
          <button type="button" title="移除链接" :disabled="!editor.isActive('link')" @click="editor.chain().focus().unsetLink().run()"><Unlink :size="16" /></button>
        </div>
        <EditorContent v-if="editor" :editor="editor" class="note-editor-content" />
      </template>
    </section>
    <UiConfirmDialog :open="deleteDialogOpen" danger title="删除这篇笔记？" :description="`“${selectedNote?.title || '无标题笔记'}”将从本机永久删除，此操作无法撤销。`" confirm-label="删除笔记" @close="deleteDialogOpen = false" @confirm="removeCurrentNote" />
  </section>
</template>
