const vscode = require('vscode')
const crypto = require('crypto')
const path = require('path')
const {
  beginLocalDataMigration,
  configureProvider,
  defaultLocalDataDirectory,
  endLocalDataMigration,
  getProviderIdentity,
  getProviderSettings,
  importFile: importLibraryFile,
  openDesktopApp,
  reparseBook,
  request,
  restartLocalRuntime,
  setLocalDataDirectory,
  shutdownLocalRuntime
} = require('./bridge')
const { lineStartFromProgress } = require('./reader-utils')
const { createWheelBridge } = require('./wheel-bridge')
const { selectImportFile } = require('./import-selection')

const MODAL_CANCEL_ACTION = Object.freeze({ title: '取消', isCloseAffordance: true })

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

// Temporarily keep chapter navigation out of the inline fixed header.
const INLINE_CHAPTER_CONTROLS_ENABLED = false

function currentChapterIndex() {
  return state.chapter ? state.chapters.findIndex(chapter => chapter.number === state.chapter.number) : -1
}

function overallProgress() {
  const index = currentChapterIndex()
  if (index < 0 || !state.chapters.length) return 0
  return Math.max(0, Math.min(100, ((index + currentProgress() / 100) / state.chapters.length) * 100))
}

function readerHeader() {
  const index = currentChapterIndex()
  if (index < 0 || !state.chapter) return '尚未加载章节 · 总进度 0.0%'
  return `第 ${index + 1}/${state.chapters.length} 章 · ${state.chapter.title} · 总进度 ${overallProgress().toFixed(1)}%`
}

function createReader(context, wheelBridge) {
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
  // A client identity belongs to one extension-host process. Persisted identities are
  // shared by multiple VS Code windows and can make equal sequence numbers look like
  // duplicate writes even when they came from different readers.
  const progressClientId = crypto.randomUUID()
  let progressSequence = 0

  const updateNavigationContexts = () => {
    const index = currentChapterIndex()
    vscode.commands.executeCommand('setContext', 'novelLibrary.hasPreviousChapter', index > 0)
    vscode.commands.executeCommand(
      'setContext',
      'novelLibrary.hasNextChapter',
      index >= 0 && index < state.chapters.length - 1
    )
  }

  const clear = () => {
    if (previousEditor) previousEditor.setDecorations(decoration, [])
    previousEditor = undefined
    status.hide()
  }

  const render = () => {
    updateNavigationContexts()
    if (!state.enabled || !state.chapter) {
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
    const display = [readerHeader(), ...visible].slice(0, editor.document.lineCount)
    const maximumStart = Math.max(0, editor.document.lineCount - display.length)
    const cursorLine = editor.selection.active.line
    const sourceStart = Math.min(cursorLine, maximumStart)
    const chapterIndex = currentChapterIndex()
    const options = display.map((text, index) => {
      const line = editor.document.lineAt(sourceStart + index)
      const isParagraph = state.displayMode === 'paragraph'
      const isHeader = index === 0
      const wheelMarker = wheelBridge.markerCss()
      const navigationMarker = isHeader && INLINE_CHAPTER_CONTROLS_ENABLED
        ? wheelBridge.navigationCss({
            previousEnabled: chapterIndex > 0,
            nextEnabled: chapterIndex >= 0 && chapterIndex < state.chapters.length - 1
          })
        : ''
      const contentText = text
      return {
        range: isParagraph
          ? new vscode.Range(line.range.start, line.range.start)
          : new vscode.Range(line.range.end, line.range.end),
        renderOptions: {
          ...(isParagraph
            ? {
                before: {
                  contentText,
                  color: new vscode.ThemeColor('editor.foreground'),
                  backgroundColor: new vscode.ThemeColor('editor.background'),
                  fontStyle: 'normal',
                  width: '74ch',
                  margin: '0 2em 0 0',
                  textDecoration: `none; ${wheelMarker}${navigationMarker} display: inline-block; white-space: pre; overflow: hidden;`
                }
              }
            : {
                after: {
                  contentText: `  ${contentText}`,
                  color: new vscode.ThemeColor('editorCodeLens.foreground'),
                  fontStyle: 'italic',
                  margin: '0 0 0 2em',
                  textDecoration: `none; ${wheelMarker}${navigationMarker}`
                }
              })
        }
      }
    })
    editor.setDecorations(decoration, options)
    const end = Math.min(state.lines.length, state.lineStart + 5)
    const mode = state.displayMode === 'paragraph' ? '段落' : '行尾'
    status.text = `$(book) ${readerHeader()} · ${state.lineStart + 1}-${end} · ${mode}`
    status.show()
  }

  let progressWriteQueue = Promise.resolve()
  const pendingProgressStorageKey = 'novelLibrary.pendingProgress.v1'

  const legacyProgressProviderKey = () => getProviderSettings().useDesktopLibrary
    ? 'desktop'
    : `local:${path.resolve(getProviderSettings().localDataDirectory).toLowerCase()}`
  const progressProviderKey = () => getProviderIdentity()

  const pendingProgressKey = progress => `${progressProviderKey()}::${progress.bookId}`

  const rememberPendingProgress = async progress => {
    const pending = storage.get(pendingProgressStorageKey, {})
    pending[pendingProgressKey(progress)] = {
      providerKey: progressProviderKey(),
      route: getProviderSettings().useDesktopLibrary ? '/v1/progress' : '/v2/progress',
      progress,
      savedAt: Date.now()
    }
    const entries = Object.entries(pending).sort((left, right) => right[1].savedAt - left[1].savedAt).slice(0, 100)
    await storage.update(pendingProgressStorageKey, Object.fromEntries(entries))
  }

  const clearPendingProgress = async progress => {
    const pending = storage.get(pendingProgressStorageKey, {})
    delete pending[pendingProgressKey(progress)]
    await storage.update(pendingProgressStorageKey, pending)
  }

  const replayPendingProgress = async () => {
    const pending = storage.get(pendingProgressStorageKey, {})
    const providerKey = progressProviderKey()
    for (const [key, item] of Object.entries(pending)) {
      if (item.providerKey !== providerKey && item.providerKey !== legacyProgressProviderKey()) continue
      try {
        await request(item.route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.progress)
        })
        delete pending[key]
      } catch (error) {
        if (error.code === 'PROGRESS_CONFLICT') delete pending[key]
      }
    }
    await storage.update(pendingProgressStorageKey, pending)
  }

  const rememberProgress = ({ bookId, chapterNumber, chapterProgress, revision }) => {
    const updateBook = book => book?.id === bookId
      ? { ...book, currentChapter: chapterNumber, chapterProgress, revision: revision ?? book.revision }
      : book
    state.books = state.books.map(updateBook)
    state.book = updateBook(state.book)
  }

  const persistProgress = async () => {
    if (!state.book || !state.chapter) return
    progressSequence += 1
    const progress = {
      bookId: state.book.id,
      chapterNumber: state.chapter.number,
      chapterProgress: currentProgress(),
      ...(getProviderSettings().useDesktopLibrary
        ? {}
        : {
            baseRevision: state.book.revision || 0,
            clientId: progressClientId,
            sequence: progressSequence,
            lineIndex: state.lineStart
          })
    }
    rememberProgress(progress)
    const write = progressWriteQueue.then(async () => {
      try {
        const saved = await request(getProviderSettings().useDesktopLibrary ? '/v1/progress' : '/v2/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(progress)
        })
        rememberProgress({ ...progress, revision: saved.revision })
        await clearPendingProgress(progress)
        return saved
      } catch (error) {
        if (error.code === 'PROGRESS_CONFLICT') {
          await clearPendingProgress(progress)
          const latest = await latestBook(state.book)
          state.book = latest
          return { conflict: true }
        }
        await rememberPendingProgress(progress)
        throw error
      }
    })
    progressWriteQueue = write.catch(() => {})
    await write
  }

  const latestBook = async book => {
    const latest = await request(`/v1/books/${encodeURIComponent(book.id)}`)
    const resolved = latest || book
    state.books = state.books.map(item => item.id === resolved.id ? resolved : item)
    return resolved
  }

  const flushCurrentBookProgress = async nextBookId => {
    if (state.book && state.chapter && state.book.id !== nextBookId) await persistProgress()
    await progressWriteQueue
  }

  const updateChapter = async (
    chapterNumber,
    direction = 1,
    restoredLineStart,
    restoredProgress,
    { startAtEnd = false, keepCurrentOnEmpty = false } = {}
  ) => {
    if (!state.book) return
    let index = state.chapters.findIndex(chapter => chapter.number === chapterNumber)
    for (let attempts = 0; index >= 0 && index < state.chapters.length && attempts < 30; attempts += 1, index += direction) {
      const chapter = await request(`/v1/books/${encodeURIComponent(state.book.id)}/chapters/${state.chapters[index].number}`)
      const lines = displayLines(chapter.contentText || chapter.content)
      if (lines.length) {
        state.chapter = chapter
        state.lines = lines
        const requestedLineStart = restoredProgress === undefined
          ? (restoredLineStart ?? 0)
          : lineStartFromProgress(lines.length, restoredProgress)
        const maximumStart = Math.max(0, lines.length - 5)
        state.lineStart = chapter.number === chapterNumber && (restoredProgress !== undefined || restoredLineStart !== undefined)
          ? Math.max(0, Math.min(maximumStart, requestedLineStart))
          : startAtEnd ? maximumStart : 0
        render()
        notifySidebar()
        await persistProgress()
        return true
      }
    }
    if (keepCurrentOnEmpty) {
      render()
      notifySidebar()
      return false
    }
    throw new Error('附近没有可阅读的正文章节')
  }

  const loadBook = async (book, position) => {
    await flushCurrentBookProgress(book.id)
    const previous = {
      book: state.book,
      chapters: state.chapters,
      chapter: state.chapter,
      lines: state.lines,
      lineStart: state.lineStart
    }
    try {
      const resolvedBook = await latestBook(book)
      state.book = resolvedBook
      const allChapters = await request(`/v1/books/${encodeURIComponent(resolvedBook.id)}/chapters`)
      const readableChapters = allChapters.filter(chapter => !chapter.kind || chapter.kind === 'chapter')
      state.chapters = readableChapters.length ? readableChapters : allChapters
      if (!state.chapters.length) throw new Error('当前小说没有可阅读章节')
      const preferredChapter = position?.chapterNumber ?? resolvedBook.currentChapter
      const preferred = state.chapters.find(chapter => chapter.number === preferredChapter) || state.chapters[0]
      const restoredLineStart = preferred.number === position?.chapterNumber ? position.lineStart : 0
      const restoredProgress = !position && preferred.number === resolvedBook.currentChapter
        ? resolvedBook.chapterProgress
        : undefined
      await updateChapter(preferred.number, 1, restoredLineStart, restoredProgress)
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
      await replayPendingProgress()
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
      await persistProgress()
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
      if (!silent) vscode.window.showErrorMessage(`小说阅读器无法连接当前书库：${error.message}`)
      return false
    }
  }

  const moveLines = async direction => {
    if (!state.chapter) await loadLibrary()
    if (!direction || !state.chapter || !state.lines.length) return
    const maximumStart = Math.max(0, state.lines.length - 5)
    const nextLineStart = state.lineStart + direction
    if (nextLineStart < 0 || nextLineStart > maximumStart) {
      const currentIndex = currentChapterIndex()
      const nextIndex = currentIndex + (direction > 0 ? 1 : -1)
      if (nextIndex < 0 || nextIndex >= state.chapters.length) return
      await updateChapter(
        state.chapters[nextIndex].number,
        direction,
        undefined,
        undefined,
        { startAtEnd: direction < 0, keepCurrentOnEmpty: true }
      )
      return
    }
    state.lineStart = nextLineStart
    render()
    notifySidebar()
    await persistProgress()
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

  const resetProvider = async () => {
    if (state.book && state.chapter) await persistProgress().catch(() => {})
    await progressWriteQueue
    state.books = []
    state.chapters = []
    state.book = null
    state.chapter = null
    state.lines = []
    state.lineStart = 0
    state.connected = false
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
    resetProvider,
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
      const local = !getProviderSettings().useDesktopLibrary
      return [
        {
          id: 'provider.status',
          type: 'status',
          label: `数据源：${local ? '本地书库' : '桌面书库'}`,
          description: state.connected ? '已连接' : state.loading ? '正在连接' : '离线',
          tooltip: local
            ? `本地数据目录：${getProviderSettings().localDataDirectory}`
            : '桌面模式只连接桌面端书库，连接失败时不会静默切换到本地书库',
          icon: state.connected ? 'pass-filled' : state.loading ? 'loading~spin' : 'warning',
          contextValue: 'providerStatus'
        },
        {
          id: 'section.books',
          type: 'books',
          label: `书架 (${state.books.length})`,
          description: state.book?.title || '',
          tooltip: getProviderSettings().useDesktopLibrary ? '桌面端小说书架' : '本地 Runtime 小说书架',
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
        const source = getProviderSettings().useDesktopLibrary ? '桌面端书库' : '本地书库'
        return [this.emptyItem(state.connected ? `${source}暂无小说` : `正在等待${source}连接（将自动重试）`)]
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
          book,
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
      const header = {
        id: `reader.header.${state.chapter?.number || 0}.${state.lineStart}`,
        label: readerHeader(),
        tooltip: '可使用阅读器标题栏的上一章、下一章按钮切换',
        icon: 'bookmark'
      }
      if (!visible.length) return [header, this.emptyItem('暂无正文')]
      return [header, ...visible.map((line, index) => ({
        id: `line.${state.chapter?.number || 0}.${state.lineStart + index}`,
        label: line,
        description: `${state.lineStart + index + 1}`,
        tooltip: line,
        icon: 'quote'
      }))]
    }

    return []
  }

  emptyItem(label) {
    return { label, icon: 'info', contextValue: 'empty' }
  }
}

function activate(context) {
  const configuration = vscode.workspace.getConfiguration('novelLibrary')
  const desktopSetting = configuration.inspect('useDesktopLibrary')?.globalValue
  const dataDirectorySetting = configuration.inspect('localDataDirectory')?.globalValue
  configureProvider({
    useDesktopLibrary: desktopSetting ?? context.globalState.get('novelLibrary.useDesktopLibrary', true),
    localDataDirectory: dataDirectorySetting || context.globalState.get('novelLibrary.localDataDirectory') || undefined,
    runtimePath: context.globalState.get('novelLibrary.runtimePath') || undefined,
    logLevel: configuration.get('logLevel', 'info'),
    retainManagedSource: configuration.get('retainManagedSource', true)
  })
  let reader
  const wheelBridge = createWheelBridge(
    direction => reader?.moveLines(direction),
    () => reader?.render(),
    direction => reader?.moveChapter(direction)
  )
  context.subscriptions.push(wheelBridge)
  reader = createReader(context, wheelBridge)
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
  vscode.commands.executeCommand('setContext', 'novelLibrary.useDesktopLibrary', getProviderSettings().useDesktopLibrary)
  let applyingConfiguration = false
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
    if (applyingConfiguration) return
    if (!event.affectsConfiguration('novelLibrary.useDesktopLibrary') && !event.affectsConfiguration('novelLibrary.localDataDirectory') && !event.affectsConfiguration('novelLibrary.logLevel') && !event.affectsConfiguration('novelLibrary.retainManagedSource')) return
    const previous = getProviderSettings()
    const nextUseDesktop = configuration.get('useDesktopLibrary', true)
    const configuredDirectory = configuration.get('localDataDirectory', '').trim()
    const nextDirectory = configuredDirectory || defaultLocalDataDirectory()
    let migrationLock
    try {
      await reader.resetProvider()
      if (path.resolve(nextDirectory) !== path.resolve(previous.localDataDirectory)) {
        migrationLock = beginLocalDataMigration(previous.localDataDirectory)
        await shutdownLocalRuntime()
        setLocalDataDirectory(nextDirectory)
      }
      configureProvider({
        useDesktopLibrary: nextUseDesktop,
        localDataDirectory: nextDirectory,
        logLevel: configuration.get('logLevel', 'info'),
        retainManagedSource: configuration.get('retainManagedSource', true)
      })
      await context.globalState.update('novelLibrary.useDesktopLibrary', nextUseDesktop)
      await context.globalState.update('novelLibrary.localDataDirectory', path.resolve(nextDirectory))
      vscode.commands.executeCommand('setContext', 'novelLibrary.useDesktopLibrary', nextUseDesktop)
      await reader.loadLibrary()
    } catch (error) {
      vscode.window.showErrorMessage(`小说书库设置应用失败：${error.message}`)
    } finally {
      endLocalDataMigration(migrationLock)
    }
  }))
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
  const configureShortcuts = () => vscode.commands.executeCommand(
    'workbench.action.openGlobalKeybindings',
    '@ext:novel-library.novel-library-reader'
  )
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.configureShortcuts', configureShortcuts))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.toggleLibraryMode', async () => {
    const current = getProviderSettings()
    const nextUseDesktop = !current.useDesktopLibrary
    if (nextUseDesktop) {
      const choice = await vscode.window.showInformationMessage(
        '切换后将使用桌面端书库；本地书库数据会保留。',
        { modal: true },
        '切换到桌面端',
        MODAL_CANCEL_ACTION
      )
      if (choice !== '切换到桌面端') return
    } else {
      const choice = await vscode.window.showInformationMessage(
        '切换后将由插件维护独立本地书库；桌面书库不会被修改。',
        { modal: true },
        '切换到本地',
        MODAL_CANCEL_ACTION
      )
      if (choice !== '切换到本地') return
    }
    await reader.resetProvider()
    applyingConfiguration = true
    try {
      await configuration.update('useDesktopLibrary', nextUseDesktop, vscode.ConfigurationTarget.Global)
      await context.globalState.update('novelLibrary.useDesktopLibrary', nextUseDesktop)
    } finally {
      applyingConfiguration = false
    }
    configureProvider({ useDesktopLibrary: nextUseDesktop })
    vscode.commands.executeCommand('setContext', 'novelLibrary.useDesktopLibrary', nextUseDesktop)
    await reader.loadLibrary()
  }))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.configureLocalDataDirectory', async () => {
    const current = getProviderSettings()
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '选择本地书库目录',
      defaultUri: vscode.Uri.file(current.localDataDirectory)
    })
    if (!selected?.[0]) return
    const target = selected[0].fsPath
    const copyChoice = await vscode.window.showInformationMessage(
      `是否把当前本地书库复制到新目录？\n${target}`,
      { modal: true },
      '复制并切换',
      '空目录切换',
      MODAL_CANCEL_ACTION
    )
    if (!['复制并切换', '空目录切换'].includes(copyChoice)) return
    let migrationLock
    try {
      await reader.resetProvider()
      if (path.resolve(target) !== path.resolve(current.localDataDirectory)) {
        migrationLock = beginLocalDataMigration(current.localDataDirectory)
        await shutdownLocalRuntime()
      }
      const result = setLocalDataDirectory(target, { copyFrom: copyChoice === '复制并切换' ? current.localDataDirectory : undefined })
      applyingConfiguration = true
      try {
        await configuration.update('localDataDirectory', result.directory, vscode.ConfigurationTarget.Global)
        await configuration.update('useDesktopLibrary', false, vscode.ConfigurationTarget.Global)
        await context.globalState.update('novelLibrary.localDataDirectory', result.directory)
        await context.globalState.update('novelLibrary.useDesktopLibrary', false)
      } finally {
        applyingConfiguration = false
      }
      configureProvider({ useDesktopLibrary: false, localDataDirectory: result.directory })
      vscode.commands.executeCommand('setContext', 'novelLibrary.useDesktopLibrary', false)
      await reader.loadLibrary()
      vscode.window.showInformationMessage(`本地书库目录已切换：${result.directory}`)
    } catch (error) {
      vscode.window.showErrorMessage(`本地书库目录切换失败：${error.message}`)
    } finally {
      endLocalDataMigration(migrationLock)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.openLocalDataDirectory', async () => {
    const directory = getProviderSettings().localDataDirectory
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(directory))
  }))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.restartLocalRuntime', async () => {
    if (getProviderSettings().useDesktopLibrary) {
      vscode.window.showInformationMessage('当前是桌面端模式，无需重启本地 Runtime')
      return
    }
    try {
      await restartLocalRuntime()
      await reader.loadLibrary()
    } catch (error) {
      vscode.window.showErrorMessage(`本地 Runtime 重启失败：${error.message}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.showShortcuts', async () => {
    const choice = await vscode.window.showInformationMessage('小说书库快捷键', {
      modal: true,
      detail: [
        '以下为默认键位，可在 VS Code / Cursor 快捷键设置中覆盖：',
        '',
        'Ctrl+Alt+N    开启或关闭代码内阅读',
        'Ctrl+Alt+9    切换段落/行尾显示模式',
        'Ctrl+Alt+↑    上一行',
        'Ctrl+Alt+↓    下一行',
        'Ctrl+Alt+←    上一章',
        'Ctrl+Alt+→    下一章',
        'Ctrl+Alt+D    打开小说书库桌面端'
      ].join('\n')
    }, '打开快捷键设置', MODAL_CANCEL_ACTION)
    if (choice === '打开快捷键设置') await configureShortcuts()
  }))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.openDesktop', async () => {
    if (!getProviderSettings().useDesktopLibrary) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(getProviderSettings().localDataDirectory))
      return
    }
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
    const file = await selectImportFile(vscode.window, uri)
    if (!file) return
    try {
      const job = await importLibraryFile(file.fsPath)
      if (job.state === 'completed') await reader.loadLibrary()
      vscode.window.showInformationMessage(job.state === 'completed' ? '小说导入完成' : '已发送到桌面端导入队列')
    } catch (error) {
      vscode.window.showErrorMessage(`导入失败：${error.message}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.deleteCurrentBook', async item => {
    if (getProviderSettings().useDesktopLibrary) {
      vscode.window.showInformationMessage('删除书籍请在桌面端中操作；本命令仅管理本地书库。')
      return
    }
    const selectedBook = item?.book || state.book
    if (!selectedBook) {
      vscode.window.showInformationMessage('请先在书架中选择要删除的书籍')
      return
    }
    const choice = await vscode.window.showWarningMessage(
      `确定从本地书库删除《${selectedBook.title}》及其受管源文件吗？`,
      { modal: true },
      '删除',
      MODAL_CANCEL_ACTION
    )
    if (choice !== '删除') return
    try {
      await request(`/v2/books/${encodeURIComponent(selectedBook.id)}`, { method: 'DELETE' })
      if (state.book?.id === selectedBook.id) {
        state.book = null
        state.chapter = null
        state.chapters = []
        state.lines = []
      }
      await reader.loadLibrary()
      vscode.window.showInformationMessage(`《${selectedBook.title}》已从本地书库删除`)
    } catch (error) {
      vscode.window.showErrorMessage(`删除失败：${error.message}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.reparseCurrentBook', async () => {
    if (getProviderSettings().useDesktopLibrary) {
      vscode.window.showInformationMessage('重新解析仅适用于本地书库')
      return
    }
    if (!state.book) {
      vscode.window.showInformationMessage('当前没有可重新解析的书籍')
      return
    }
    try {
      await reparseBook(state.book.id)
      await reader.loadLibrary()
      vscode.window.showInformationMessage('本地书籍重新解析完成')
    } catch (error) {
      vscode.window.showErrorMessage(`重新解析失败：${error.message}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.backupCurrentLibrary', async () => {
    const sourceName = getProviderSettings().useDesktopLibrary ? 'desktop' : 'local'
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const selected = await vscode.window.showSaveDialog({
      title: '备份当前小说书库',
      defaultUri: vscode.Uri.file(path.join(getProviderSettings().localDataDirectory, 'backups', `novel-library-${sourceName}-${timestamp}.json`)),
      filters: { '小说书库备份': ['json', 'novellibrary-backup'] },
      saveLabel: '创建备份'
    })
    if (!selected) return
    try {
      const result = await request('/v2/transfers/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selected.fsPath })
      })
      vscode.window.showInformationMessage(`书库备份完成：${result.bookCount ?? result.books ?? 0} 本`)
    } catch (error) {
      vscode.window.showErrorMessage(`备份失败：${error.message}`)
    }
  }))
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.restoreCurrentLibrary', async () => {
    const selected = await vscode.window.showOpenDialog({
      title: '恢复或迁移小说书库',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { '小说书库备份': ['json', 'novellibrary-backup', 'novellibrary-transfer'] },
      openLabel: '选择备份'
    })
    if (!selected?.[0]) return
    const local = !getProviderSettings().useDesktopLibrary
    const choices = local ? ['合并恢复', '清空并恢复', MODAL_CANCEL_ACTION] : ['合并恢复', MODAL_CANCEL_ACTION]
    const choice = await vscode.window.showWarningMessage(
      local ? '请选择恢复方式；“清空并恢复”会先自动备份当前本地书库。' : '备份内容将合并到当前桌面书库。',
      { modal: true },
      ...choices
    )
    if (!['合并恢复', '清空并恢复'].includes(choice)) return
    try {
      await request('/v2/transfers/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selected[0].fsPath, strategy: choice === '清空并恢复' ? 'replace' : 'merge' })
      })
      state.book = null
      state.chapter = null
      await reader.loadLibrary()
      vscode.window.showInformationMessage('书库恢复完成')
    } catch (error) {
      vscode.window.showErrorMessage(`恢复失败：${error.message}`)
    }
  }))
  const diagnosticsOutput = vscode.window.createOutputChannel('小说书库诊断')
  context.subscriptions.push(diagnosticsOutput)
  context.subscriptions.push(vscode.commands.registerCommand('novelLibrary.openDiagnostics', async () => {
    if (getProviderSettings().useDesktopLibrary) {
      vscode.window.showInformationMessage('Runtime 诊断仅适用于本地书库')
      return
    }
    try {
      const diagnostics = await request('/v2/runtime/diagnostics')
      diagnosticsOutput.clear()
      diagnosticsOutput.appendLine(`插件版本：${context.extension.packageJSON.version}`)
      diagnosticsOutput.appendLine(`IDE：${vscode.env.appName} ${vscode.version}`)
      diagnosticsOutput.appendLine('当前模式：本地书库')
      diagnosticsOutput.appendLine(`Runtime：${diagnostics.runtimeVersion || '未知'}`)
      diagnosticsOutput.appendLine(`协议版本：${diagnostics.protocolVersion ?? '未知'}`)
      diagnosticsOutput.appendLine(`storageId：…${diagnostics.storageIdSuffix || '未知'}`)
      diagnosticsOutput.appendLine(`数据库 schema：${diagnostics.schemaVersion ?? '未知'}`)
      diagnosticsOutput.appendLine(`服务：PID ${diagnostics.pid ?? '未知'} / 端口 ${diagnostics.port ?? '未知'}`)
      diagnosticsOutput.appendLine(`完整性：${diagnostics.integrity || '未知'}`)
      diagnosticsOutput.appendLine(`书籍：${diagnostics.bookCount ?? 0} / 待处理导入：${diagnostics.pendingImportJobs ?? 0}`)
      diagnosticsOutput.appendLine(`数据目录：${diagnostics.dataDirectory || '未知'}`)
      diagnosticsOutput.appendLine(`日志目录：${diagnostics.logDirectory || '未知'}`)
      diagnosticsOutput.show(true)
    } catch (error) {
      vscode.window.showErrorMessage(`诊断失败：${error.message}`)
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
