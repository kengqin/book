const vscode = require('vscode')
const fs = require('fs')
const { bridgeFile, request } = require('./bridge')

const state = {
  books: [],
  chapters: [],
  book: null,
  chapter: null,
  lines: [],
  lineStart: 0,
  enabled: false,
  loading: false
}

function displayLines(text) {
  const lines = []
  for (const paragraph of String(text || '').replace(/\r/g, '').split(/\n+/)) {
    let line = ''
    for (const char of paragraph.trim()) {
      line += char
      if (line.length >= 42 || (line.length >= 18 && /[，。！？；：、,.!?;:]/.test(char))) {
        lines.push(line)
        line = ''
      }
    }
    if (line) lines.push(line)
  }
  return lines.filter(Boolean)
}

function currentProgress() {
  if (state.lines.length <= 5) return 100
  return (state.lineStart / (state.lines.length - 5)) * 100
}

function createReader(context) {
  const decoration = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen
  })
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  status.command = 'novelLibrary.openReader'
  status.tooltip = '小说书库：点击显示或隐藏代码内阅读'
  let previousEditor
  let notifySidebar = () => {}

  const clear = () => {
    if (previousEditor) previousEditor.setDecorations(decoration, [])
    previousEditor = undefined
    status.hide()
  }

  const render = () => {
    if (!state.enabled || !state.chapter || !state.lines.length) {
      clear()
      return
    }
    const editor = vscode.window.activeTextEditor
    if (!editor || !['file', 'untitled'].includes(editor.document.uri.scheme)) {
      clear()
      return
    }
    if (previousEditor && previousEditor !== editor) previousEditor.setDecorations(decoration, [])
    previousEditor = editor
    const visible = state.lines.slice(state.lineStart, state.lineStart + 5)
    const maximumStart = Math.max(0, editor.document.lineCount - visible.length)
    const cursorLine = editor.selection.active.line
    const sourceStart = Math.min(cursorLine, maximumStart)
    const options = visible.map((text, index) => {
      const line = editor.document.lineAt(sourceStart + index)
      return {
        range: new vscode.Range(line.range.end, line.range.end),
        hoverMessage: `${state.book?.title || ''} · ${state.chapter.title}`,
        renderOptions: {
          after: {
            contentText: `  ${text}`,
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            fontStyle: 'italic',
            margin: '0 0 0 2em'
          }
        }
      }
    })
    editor.setDecorations(decoration, options)
    const end = Math.min(state.lines.length, state.lineStart + 5)
    status.text = `$(book) ${state.book?.title || '小说'} · ${state.lineStart + 1}-${end}`
    status.show()
  }

  const persistProgress = () => {
    if (!state.book || !state.chapter) return
    request('/v1/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: state.book.id,
        chapterNumber: state.chapter.number,
        chapterProgress: currentProgress()
      })
    }).catch(() => {})
  }

  const updateChapter = async (chapterNumber, direction = 1) => {
    if (!state.book) return
    let index = state.chapters.findIndex(chapter => chapter.number === chapterNumber)
    for (let attempts = 0; index >= 0 && index < state.chapters.length && attempts < 30; attempts += 1, index += direction) {
      const chapter = await request(`/v1/books/${encodeURIComponent(state.book.id)}/chapters/${state.chapters[index].number}`)
      const lines = displayLines(chapter.contentText || chapter.content)
      if (lines.length) {
        state.chapter = chapter
        state.lines = lines
        state.lineStart = 0
        render()
        notifySidebar()
        return
      }
    }
    throw new Error('附近没有可阅读的正文章节')
  }

  const loadBook = async book => {
    state.book = book
    const allChapters = await request(`/v1/books/${encodeURIComponent(book.id)}/chapters`)
    const readableChapters = allChapters.filter(chapter => !chapter.kind || chapter.kind === 'chapter')
    state.chapters = readableChapters.length ? readableChapters : allChapters
    if (!state.chapters.length) throw new Error('当前小说没有可阅读章节')
    const preferred = state.chapters.find(chapter => chapter.number === book.currentChapter) || state.chapters[0]
    await updateChapter(preferred.number, 1)
  }

  const loadLibrary = async () => {
    if (state.loading) return
    state.loading = true
    try {
      state.books = await request('/v1/books')
      if (!state.books.length) throw new Error('桌面端书库中还没有小说')
      const book = state.book && state.books.find(item => item.id === state.book.id) || state.books[0]
      await loadBook(book)
    } finally {
      state.loading = false
    }
  }

  const toggle = async forceVisible => {
    if (forceVisible === false || (forceVisible === undefined && state.enabled)) {
      state.enabled = false
      clear()
      notifySidebar()
      return
    }
    state.enabled = true
    try {
      if (!state.chapter) await loadLibrary()
      render()
      notifySidebar()
    } catch (error) {
      state.enabled = false
      clear()
      notifySidebar()
      vscode.window.showErrorMessage(`小说阅读器无法连接桌面端：${error.message}`)
    }
  }

  const moveLines = async direction => {
    if (!state.enabled) await toggle(true)
    const maximumStart = Math.max(0, state.lines.length - 5)
    state.lineStart = Math.max(0, Math.min(maximumStart, state.lineStart + direction))
    render()
    notifySidebar()
    persistProgress()
  }

  const moveChapter = async direction => {
    if (!state.enabled) await toggle(true)
    if (!state.chapters.length || !state.chapter) return
    const currentIndex = state.chapters.findIndex(chapter => chapter.number === state.chapter.number)
    const nextIndex = Math.max(0, Math.min(state.chapters.length - 1, currentIndex + direction))
    if (nextIndex !== currentIndex) await updateChapter(state.chapters[nextIndex].number, direction)
  }

  const selectBook = async () => {
    if (!state.books.length) await loadLibrary()
    const picked = await vscode.window.showQuickPick(
      state.books.map(book => ({ label: book.title, description: book.author || '', book })),
      { placeHolder: '选择要阅读的小说' }
    )
    if (picked) await loadBook(picked.book)
  }

  const selectChapter = async () => {
    if (!state.book || !state.chapters.length) await loadLibrary()
    const picked = await vscode.window.showQuickPick(
      state.chapters.map(chapter => ({ label: chapter.title, description: `第 ${chapter.number} 项`, chapter })),
      { placeHolder: '选择章节' }
    )
    if (picked) await updateChapter(picked.chapter.number, 1)
  }

  context.subscriptions.push(decoration, status)
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(render))
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
    if (event.textEditor === vscode.window.activeTextEditor) render()
  }))
  return {
    clear,
    render,
    toggle,
    moveLines,
    moveChapter,
    selectBook,
    selectChapter,
    setSidebarRefresh(callback) {
      notifySidebar = callback
      notifySidebar()
    }
  }
}

class ReaderTreeProvider {
  constructor() {
    this.changed = new vscode.EventEmitter()
    this.onDidChangeTreeData = this.changed.event
  }

  refresh() {
    this.changed.fire()
  }

  getTreeItem(item) {
    const treeItem = new vscode.TreeItem(item.label)
    if (item.command) treeItem.command = { command: item.command, title: item.label }
    treeItem.iconPath = new vscode.ThemeIcon(item.icon)
    treeItem.description = item.description
    treeItem.tooltip = item.tooltip || item.label
    return treeItem
  }

  getChildren() {
    const visible = state.lines.slice(state.lineStart, state.lineStart + 5)
    return [
      { label: state.book?.title || '选择小说', description: '当前书籍', command: 'novelLibrary.selectBook', icon: 'book' },
      { label: state.chapter?.title || '选择章节', description: '当前章节', command: 'novelLibrary.selectChapter', icon: 'list-selection' },
      ...visible.map((line, index) => ({ label: line, description: `${state.lineStart + index + 1}`, tooltip: line, icon: 'quote' })),
      { label: state.enabled ? '隐藏代码内阅读' : '显示代码内阅读', command: 'novelLibrary.openReader', icon: state.enabled ? 'eye-closed' : 'eye' },
      { label: '上一行', command: 'novelLibrary.previousLine', icon: 'arrow-up' },
      { label: '下一行', command: 'novelLibrary.nextLine', icon: 'arrow-down' },
      { label: '上一章', command: 'novelLibrary.previousChapter', icon: 'arrow-left' },
      { label: '下一章', command: 'novelLibrary.nextChapter', icon: 'arrow-right' },
      { label: '导入当前文件', command: 'novelLibrary.importFile', icon: 'file-add' }
    ]
  }
}

function activate(context) {
  const reader = createReader(context)
  const treeProvider = new ReaderTreeProvider()
  reader.setSidebarRefresh(() => treeProvider.refresh())
  context.subscriptions.push(treeProvider.changed)
  context.subscriptions.push(vscode.window.registerTreeDataProvider('novelLibrary.reader', treeProvider))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.openReader', () => reader.toggle()))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.selectBook', () => reader.selectBook()))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.selectChapter', () => reader.selectChapter()))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.nextLine', () => reader.moveLines(1)))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.previousLine', () => reader.moveLines(-1)))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.nextChapter', () => reader.moveChapter(1)))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.previousChapter', () => reader.moveChapter(-1)))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.openDesktop', async () => {
    try {
      await vscode.env.openExternal(vscode.Uri.parse('novellibrary://open'))
    } catch (error) {
      vscode.window.showErrorMessage(error.message)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.importFile', async uri => {
    const file = uri || vscode.window.activeTextEditor?.document.uri
    if (!file) return
    try {
      await request('/v1/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.fsPath })
      })
      vscode.window.showInformationMessage('已发送到小说书库导入队列')
    } catch (error) {
      vscode.window.showErrorMessage(`导入失败：${error.message}`)
    }
  }))

  if (fs.existsSync(bridgeFile())) setTimeout(() => reader.toggle(true), 500)
}

module.exports = { activate, deactivate() {} }
