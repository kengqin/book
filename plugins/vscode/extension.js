const vscode = require('vscode')
const { openDesktopApp, request } = require('./bridge')

const state = {
  books: [],
  chapters: [],
  book: null,
  chapter: null,
  lines: [],
  lineStart: 0,
  enabled: false,
  displayMode: 'paragraph',
  loading: false,
  connected: false
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
  const storage = context.globalState || {
    get: (_key, fallback) => fallback,
    update: async () => {}
  }
  state.displayMode = storage.get('novelLibrary.displayMode', 'paragraph') === 'lineEnd'
    ? 'lineEnd'
    : 'paragraph'
  state.enabled = storage.get('novelLibrary.readerEnabled', true) !== false
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
      const isParagraph = state.displayMode === 'paragraph'
      return {
        range: isParagraph
          ? new vscode.Range(line.range.start, line.range.start)
          : new vscode.Range(line.range.end, line.range.end),
        hoverMessage: `${state.book?.title || ''} · ${state.chapter.title}`,
        renderOptions: {
          ...(isParagraph
            ? {
                before: {
                  contentText: text,
                  color: new vscode.ThemeColor('editor.foreground'),
                  backgroundColor: new vscode.ThemeColor('editor.background'),
                  fontStyle: 'normal',
                  width: '74ch',
                  margin: '0 2em 0 0',
                  textDecoration: 'none; display: inline-block; white-space: pre; overflow: hidden;'
                }
              }
            : {
                after: {
                  contentText: `  ${text}`,
                  color: new vscode.ThemeColor('editorCodeLens.foreground'),
                  fontStyle: 'italic',
                  margin: '0 0 0 2em'
                }
              })
        }
      }
    })
    editor.setDecorations(decoration, options)
    const end = Math.min(state.lines.length, state.lineStart + 5)
    const mode = state.displayMode === 'paragraph' ? '段落' : '行尾'
    status.text = `$(book) ${state.book?.title || '小说'} · ${state.lineStart + 1}-${end} · ${mode}`
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

  const updateChapter = async (chapterNumber, direction = 1, restoredLineStart = 0) => {
    if (!state.book) return
    let index = state.chapters.findIndex(chapter => chapter.number === chapterNumber)
    for (let attempts = 0; index >= 0 && index < state.chapters.length && attempts < 30; attempts += 1, index += direction) {
      const chapter = await request(`/v1/books/${encodeURIComponent(state.book.id)}/chapters/${state.chapters[index].number}`)
      const lines = displayLines(chapter.contentText || chapter.content)
      if (lines.length) {
        state.chapter = chapter
        state.lines = lines
        state.lineStart = chapter.number === chapterNumber
          ? Math.max(0, Math.min(lines.length - 5, restoredLineStart))
          : 0
        render()
        notifySidebar()
        return
      }
    }
    throw new Error('附近没有可阅读的正文章节')
  }

  const loadBook = async (book, position) => {
    const previous = {
      book: state.book,
      chapters: state.chapters,
      chapter: state.chapter,
      lines: state.lines,
      lineStart: state.lineStart
    }
    try {
      state.book = book
      const allChapters = await request(`/v1/books/${encodeURIComponent(book.id)}/chapters`)
      const readableChapters = allChapters.filter(chapter => !chapter.kind || chapter.kind === 'chapter')
      state.chapters = readableChapters.length ? readableChapters : allChapters
      if (!state.chapters.length) throw new Error('当前小说没有可阅读章节')
      const preferredChapter = position?.chapterNumber ?? book.currentChapter
      const preferred = state.chapters.find(chapter => chapter.number === preferredChapter) || state.chapters[0]
      const restoredLineStart = preferred.number === position?.chapterNumber ? position.lineStart : 0
      await updateChapter(preferred.number, 1, restoredLineStart)
    } catch (error) {
      Object.assign(state, previous)
      render()
      notifySidebar()
      throw error
    }
  }

  const loadLibrary = async () => {
    if (state.loading) return false
    state.loading = true
    try {
      const position = state.book && state.chapter
        ? { bookId: state.book.id, chapterNumber: state.chapter.number, lineStart: state.lineStart }
        : undefined
      state.books = await request('/v1/books')
      state.connected = true
      if (!state.books.length) {
        state.book = null
        state.chapters = []
        state.chapter = null
        state.lines = []
        state.lineStart = 0
        render()
        notifySidebar()
        return true
      }
      const book = state.book && state.books.find(item => item.id === state.book.id) || state.books[0]
      await loadBook(book, position?.bookId === book.id ? position : undefined)
      return true
    } catch (error) {
      state.connected = false
      throw error
    } finally {
      state.loading = false
    }
  }

  const toggle = async (forceVisible, silent = false) => {
    if (forceVisible === false || (forceVisible === undefined && state.enabled)) {
      state.enabled = false
      await storage.update('novelLibrary.readerEnabled', false)
      clear()
      vscode.commands.executeCommand('setContext', 'novelLibrary.readerEnabled', false)
      notifySidebar()
      return true
    }
    state.enabled = true
    await storage.update('novelLibrary.readerEnabled', true)
    try {
      if (!state.chapter) await loadLibrary()
      render()
      vscode.commands.executeCommand('setContext', 'novelLibrary.readerEnabled', true)
      notifySidebar()
      return true
    } catch (error) {
      state.enabled = false
      clear()
      vscode.commands.executeCommand('setContext', 'novelLibrary.readerEnabled', false)
      notifySidebar()
      if (!silent) vscode.window.showErrorMessage(`小说阅读器无法连接桌面端：${error.message}`)
      return false
    }
  }

  const moveLines = async direction => {
    if (!state.chapter) await loadLibrary()
    const maximumStart = Math.max(0, state.lines.length - 5)
    state.lineStart = Math.max(0, Math.min(maximumStart, state.lineStart + direction))
    render()
    notifySidebar()
    persistProgress()
  }

  const moveChapter = async direction => {
    if (!state.chapter) await loadLibrary()
    if (!state.chapters.length || !state.chapter) return
    const currentIndex = state.chapters.findIndex(chapter => chapter.number === state.chapter.number)
    const nextIndex = Math.max(0, Math.min(state.chapters.length - 1, currentIndex + direction))
    if (nextIndex !== currentIndex) await updateChapter(state.chapters[nextIndex].number, direction)
  }

  const toggleDisplayMode = async () => {
    state.displayMode = state.displayMode === 'paragraph' ? 'lineEnd' : 'paragraph'
    await storage.update('novelLibrary.displayMode', state.displayMode)
    render()
    notifySidebar()
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
      state.chapters.map((chapter, index) => ({ label: chapter.title, description: `第 ${index + 1} 章`, chapter })),
      { placeHolder: '选择章节' }
    )
    if (picked) await updateChapter(picked.chapter.number, 1)
  }

  const openBook = async book => {
    const wasEnabled = state.enabled
    state.enabled = true
    try {
      await loadBook(book)
      vscode.commands.executeCommand('setContext', 'novelLibrary.readerEnabled', true)
      render()
    } catch (error) {
      state.enabled = wasEnabled
      vscode.commands.executeCommand('setContext', 'novelLibrary.readerEnabled', wasEnabled)
      render()
      notifySidebar()
      throw error
    }
  }

  const openChapter = async chapter => {
    const wasEnabled = state.enabled
    state.enabled = true
    try {
      await updateChapter(chapter.number, 1)
      vscode.commands.executeCommand('setContext', 'novelLibrary.readerEnabled', true)
      render()
    } catch (error) {
      state.enabled = wasEnabled
      vscode.commands.executeCommand('setContext', 'novelLibrary.readerEnabled', wasEnabled)
      render()
      notifySidebar()
      throw error
    }
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
    openBook,
    openChapter,
    loadLibrary,
    toggleDisplayMode,
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
    const treeItem = new vscode.TreeItem(item.label, item.collapsibleState ?? vscode.TreeItemCollapsibleState.None)
    treeItem.id = item.id
    if (item.command) {
      treeItem.command = { command: item.command, title: item.label, arguments: item.arguments || [] }
    }
    treeItem.iconPath = new vscode.ThemeIcon(item.icon)
    treeItem.description = item.description
    treeItem.tooltip = item.tooltip || item.label
    treeItem.contextValue = item.contextValue
    return treeItem
  }

  getChildren(element) {
    if (!element) {
      return [
        {
          id: 'section.books',
          type: 'books',
          label: `书架 (${state.books.length})`,
          description: state.book?.title || '',
          tooltip: '桌面端小说书架',
          icon: 'library',
          collapsibleState: vscode.TreeItemCollapsibleState.Expanded
        },
        {
          id: 'section.chapters',
          type: 'chapters',
          label: `章节 (${state.chapters.length})`,
          description: state.chapter?.title || '',
          tooltip: state.chapter ? `当前章节：${state.chapter.title}` : '当前小说的章节目录',
          icon: 'list-tree',
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed
        },
        {
          id: 'section.content',
          type: 'content',
          label: state.lines.length
            ? `正文 ${state.lineStart + 1}-${Math.min(state.lines.length, state.lineStart + 5)}`
            : '正文',
          description: state.enabled
            ? `${state.displayMode === 'paragraph' ? '段落模式' : '行尾模式'} · 代码内显示中`
            : state.displayMode === 'paragraph' ? '段落模式' : '行尾模式',
          tooltip: state.chapter ? `${state.book?.title || ''} · ${state.chapter.title}` : '当前阅读正文',
          icon: 'book-open',
          collapsibleState: vscode.TreeItemCollapsibleState.Expanded
        }
      ]
    }

    if (element.type === 'books') {
      if (!state.books.length) {
        return [this.emptyItem(state.connected ? '桌面端书库暂无小说' : '正在等待桌面端连接（将自动重试）')]
      }
      return state.books.map(book => {
        const current = book.id === state.book?.id
        return {
          id: `book.${book.id}`,
          label: book.title,
          description: current ? `当前${book.author ? ` · ${book.author}` : ''}` : book.author || '',
          tooltip: current ? `正在阅读：${book.title}` : `切换到《${book.title}》`,
          icon: current ? 'check' : 'book',
          command: 'novelLibrary.openBookFromSidebar',
          arguments: [book],
          contextValue: current ? 'currentBook' : 'book'
        }
      })
    }

    if (element.type === 'chapters') {
      if (!state.chapters.length) return [this.emptyItem('请先从书架选择小说')]
      return state.chapters.map((chapter, index) => {
        const current = chapter.number === state.chapter?.number
        return {
          id: `chapter.${state.book?.id || 'none'}.${chapter.number}`,
          label: chapter.title,
          description: current ? `当前 · 第 ${index + 1} 章` : `第 ${index + 1} 章`,
          tooltip: current ? `正在阅读：${chapter.title}` : `切换到 ${chapter.title}`,
          icon: current ? 'check' : 'symbol-key',
          command: 'novelLibrary.openChapterFromSidebar',
          arguments: [chapter],
          contextValue: current ? 'currentChapter' : 'chapter'
        }
      })
    }

    if (element.type === 'content') {
      const visible = state.lines.slice(state.lineStart, state.lineStart + 5)
      if (!visible.length) return [this.emptyItem('暂无正文')]
      return visible.map((line, index) => ({
        id: `line.${state.chapter?.number || 0}.${state.lineStart + index}`,
        label: line,
        description: `${state.lineStart + index + 1}`,
        tooltip: line,
        icon: 'quote'
      }))
    }

    return []
  }

  emptyItem(label) {
    return { label, icon: 'info', contextValue: 'empty' }
  }
}

function activate(context) {
  const reader = createReader(context)
  const treeProvider = new ReaderTreeProvider()
  const runReaderAction = action => async (...args) => {
    try {
      await action(...args)
    } catch (error) {
      vscode.window.showErrorMessage(`小说阅读器操作失败：${error.message}`)
    }
  }
  reader.setSidebarRefresh(() => treeProvider.refresh())
  context.subscriptions.push(treeProvider.changed)
  const treeView = vscode.window.createTreeView('novelLibrary.reader', { treeDataProvider: treeProvider })
  context.subscriptions.push(treeView)
  vscode.commands.executeCommand('setContext', 'novelLibrary.readerEnabled', false)
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.openReader', () => reader.toggle()))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.showReader', () => reader.toggle(true)))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.hideReader', () => reader.toggle(false)))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.selectBook', runReaderAction(() => reader.selectBook())))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.selectChapter', runReaderAction(() => reader.selectChapter())))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.openBookFromSidebar', runReaderAction(book => reader.openBook(book))))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.openChapterFromSidebar', runReaderAction(chapter => reader.openChapter(chapter))))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.refreshLibrary', runReaderAction(() => reader.loadLibrary())))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.toggleDisplayMode', runReaderAction(() => reader.toggleDisplayMode())))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.nextLine', runReaderAction(() => reader.moveLines(1))))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.previousLine', runReaderAction(() => reader.moveLines(-1))))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.nextChapter', runReaderAction(() => reader.moveChapter(1))))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.previousChapter', runReaderAction(() => reader.moveChapter(-1))))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.showShortcuts', () => {
    vscode.window.showInformationMessage('小说书库快捷键', {
      modal: true,
      detail: [
        'Ctrl+Alt+N    开启或关闭代码内阅读',
        'Ctrl+Alt+9    切换段落/行尾显示模式',
        'Ctrl+Alt+↑    上一行',
        'Ctrl+Alt+↓    下一行',
        'Ctrl+Alt+←    上一章',
        'Ctrl+Alt+→    下一章',
        'Ctrl+Alt+D    打开小说书库桌面端'
      ].join('\n')
    })
  }))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.openDesktop', async () => {
    try {
      await request('/v1/show', { method: 'POST' })
    } catch {
      try {
        openDesktopApp()
      } catch (error) {
        vscode.window.showErrorMessage(`无法打开小说书库桌面端：${error.message}`)
      }
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

  let reconnectTimer
  let reconnecting = false
  const scheduleReconnect = (delay = 0) => {
    if (reconnectTimer || state.connected) return
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = undefined
      if (reconnecting || state.connected) return
      reconnecting = true
      try {
        const loaded = await reader.loadLibrary()
        if (!loaded || !state.connected) {
          if (treeView.visible) scheduleReconnect(1000)
          return
        }
        vscode.commands.executeCommand('setContext', 'novelLibrary.readerEnabled', state.enabled)
        if (state.enabled) reader.render()
      } catch {
        if (treeView.visible) scheduleReconnect(3000)
      } finally {
        reconnecting = false
      }
    }, delay)
  }
  context.subscriptions.push(treeView.onDidChangeVisibility(event => {
    if (event.visible && !state.connected) scheduleReconnect()
  }))
  context.subscriptions.push(vscode.window.onDidChangeWindowState(event => {
    if (event.focused && treeView.visible && !state.connected) scheduleReconnect()
  }))
  context.subscriptions.push({
    dispose() {
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  })

  scheduleReconnect(500)
}

module.exports = { activate, deactivate() {} }
