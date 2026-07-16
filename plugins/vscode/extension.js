const vscode = require('vscode')
const fs = require('fs')
const { bridgeFile, request } = require('./bridge')

const readerUri = vscode.Uri.from({ scheme: 'novel-library', path: '/小说阅读器' })

const state = {
  books: [],
  chapters: [],
  book: null,
  chapter: null,
  lines: [],
  lineStart: 0,
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

function readerText() {
  if (!state.chapter) {
    return '小说阅读器\n\n正在等待桌面端书库 Bridge...\n\n请先启动小说书库桌面端。'
  }
  const end = Math.min(state.lines.length, state.lineStart + 5)
  const visible = state.lines.slice(state.lineStart, end)
  return [
    `小说阅读  |  ${state.book?.title || '未命名书籍'}`,
    `第 ${state.chapter.number} 章  ${state.chapter.title}`,
    `显示 ${state.lineStart + 1}-${end} / ${state.lines.length} 行  |  Ctrl+Alt+上/下滚动  Ctrl+Alt+左/右切章`,
    '',
    ...visible
  ].join('\n')
}

class ReaderDocumentProvider {
  constructor() {
    this.emitter = new vscode.EventEmitter()
    this.onDidChange = this.emitter.event
  }

  provideTextDocumentContent() {
    return readerText()
  }

  refresh() {
    this.emitter.fire(readerUri)
  }

  dispose() {
    this.emitter.dispose()
  }
}

function currentProgress() {
  if (state.lines.length <= 5) return 100
  return (state.lineStart / (state.lines.length - 5)) * 100
}

async function updateChapter(provider, chapterNumber) {
  if (!state.book) return
  state.chapter = await request(`/v1/books/${encodeURIComponent(state.book.id)}/chapters/${chapterNumber}`)
  state.lines = displayLines(state.chapter.contentText || state.chapter.content)
  state.lineStart = 0
  provider.refresh()
}

async function loadLibrary(provider) {
  if (state.loading) return
  state.loading = true
  try {
    state.books = await request('/v1/books')
    if (!state.books.length) {
      state.book = null
      state.chapter = null
      state.lines = []
      provider.refresh()
      return
    }
    state.book = state.book && state.books.find(book => book.id === state.book.id) || state.books[0]
    state.chapters = await request(`/v1/books/${encodeURIComponent(state.book.id)}/chapters`)
    if (state.chapters.length) await updateChapter(provider, state.chapters[0].number)
    else {
      state.chapter = null
      state.lines = []
      provider.refresh()
    }
  } finally {
    state.loading = false
  }
}

async function showReader(provider, focus = true) {
  const document = await vscode.workspace.openTextDocument(readerUri)
  await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: !focus,
    preview: false
  })
  await loadLibrary(provider)
}

function moveLines(provider, direction) {
  const maxStart = Math.max(0, state.lines.length - 5)
  state.lineStart = Math.max(0, Math.min(maxStart, state.lineStart + direction))
  provider.refresh()
  if (state.book && state.chapter) {
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
}

async function moveChapter(provider, direction) {
  if (!state.chapters.length || !state.chapter) return
  const currentIndex = state.chapters.findIndex(chapter => chapter.number === state.chapter.number)
  const nextIndex = Math.max(0, Math.min(state.chapters.length - 1, currentIndex + direction))
  if (nextIndex !== currentIndex) await updateChapter(provider, state.chapters[nextIndex].number)
}

class ReaderTreeProvider {
  getTreeItem(item) {
    const treeItem = new vscode.TreeItem(item.label)
    treeItem.command = { command: item.command, title: item.label }
    return treeItem
  }

  getChildren() {
    return [
      { label: '打开编辑器内阅读', command: 'novelLibrary.openReader' },
      { label: '上一行', command: 'novelLibrary.previousLine' },
      { label: '下一行', command: 'novelLibrary.nextLine' },
      { label: '上一章', command: 'novelLibrary.previousChapter' },
      { label: '下一章', command: 'novelLibrary.nextChapter' },
      { label: '导入当前文件', command: 'novelLibrary.importFile' },
      { label: '打开小说书库桌面端', command: 'novelLibrary.openDesktop' }
    ]
  }
}

function activate(context) {
  const provider = new ReaderDocumentProvider()
  let opened = false
  context.subscriptions.push(provider)
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('novel-library', provider))
  context.subscriptions.push(vscode.window.registerTreeDataProvider('novelLibrary.reader', new ReaderTreeProvider()))

  const openReader = async () => {
    opened = true
    try {
      await showReader(provider)
    } catch (error) {
      vscode.window.showErrorMessage(`小说阅读器无法连接桌面端：${error.message}`)
    }
  }
  const nextLine = () => moveLines(provider, 1)
  const previousLine = () => moveLines(provider, -1)
  const nextChapter = () => moveChapter(provider, 1)
  const previousChapter = () => moveChapter(provider, -1)

  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.openReader', openReader))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.nextLine', nextLine))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.previousLine', previousLine))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.nextChapter', nextChapter))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.previousChapter', previousChapter))
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

  // Auto-open only when the desktop bridge already exists, so installing the extension is quiet.
  if (fs.existsSync(bridgeFile())) {
    setTimeout(() => { if (!opened) openReader() }, 500)
  }
}

module.exports = { activate, deactivate() {} }
