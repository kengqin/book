<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { AlignJustify, ArrowLeft, ChevronLeft, ChevronRight, EyeOff, LogOut, Minus, Moon, Pin, Plus, RotateCcw, Settings2, Sun, Type } from 'lucide-vue-next'
import { formatChapterLabel, getCompactReaderWindow, isNumberedChapter } from '@novel-library/reader-core'
import { isTauri } from '@tauri-apps/api/core'
import { LogicalSize, PhysicalPosition, type PhysicalSize } from '@tauri-apps/api/dpi'
import { availableMonitors, getCurrentWindow } from '@tauri-apps/api/window'
import { getDesktopBook, getDesktopChapter, listDesktopChapters, saveDesktopProgress, type DesktopBook, type DesktopChapter, type DesktopChapterSummary } from '../services/desktop-library'
import { sanitizeReaderHtml } from '../services/sanitize-reader-html'
import { showGlobalError } from '../services/global-message'
import { buildPrivacyReaderText } from '../services/privacy-reader-text'
import { setWindowChrome, syncApplicationWindowChrome } from '../services/window-chrome'

const route = useRoute()
const router = useRouter()
const book = ref<DesktopBook>()
const chapter = ref<DesktopChapter>()
const chapters = ref<DesktopChapterSummary[]>([])
const loading = ref(true)
const fontSize = ref(18)
const lineHeight = ref(2.05)
const palette = ref<'light' | 'paper' | 'night'>('paper')
const compactMode = ref(false)
const compactLines = ref(5)
const compactColumns = ref(36)
const compactAnchor = ref(0)
const privacyAnchor = ref(0)
const privacyMode = ref(false)
type PrivacyPalette = 'light' | 'night'
const privacyPalette = ref<PrivacyPalette>('light')
const privacyAlwaysOnTop = ref(false)
const privacySettingsOpen = ref(false)
const privacyFontSize = ref(12)
const privacyLineHeight = ref(1.9)
const privacyCustomTextColors = ref<Record<PrivacyPalette, string>>({ light: '', night: '' })
const privacyCustomTextColor = computed({
  get: () => privacyCustomTextColors.value[privacyPalette.value],
  set: value => {
    privacyCustomTextColors.value = { ...privacyCustomTextColors.value, [privacyPalette.value]: value }
  }
})
const privacyViewportWidth = ref(300)
const privacyViewportHeight = ref(200)
let scrollRoot: HTMLElement | null = null
let progressTimer = 0
let privacyBoundsTimer = 0
let progressSaveFailed = false
let unlistenPrivacyResize: (() => void) | undefined
let unlistenPrivacyMove: (() => void) | undefined

const APPLICATION_MIN_SIZE = new LogicalSize(760, 560)
const PRIVACY_DEFAULT_SIZE = new LogicalSize(300, 200)
const PRIVACY_MIN_SIZE = new LogicalSize(240, 160)
const PRIVACY_BOUNDS_STORAGE_KEY = 'desktop-reader-privacy-window-bounds'
const PRIVACY_SETTINGS_STORAGE_KEY = 'desktop-reader-privacy-settings'
const PRIVACY_HORIZONTAL_PADDING = 28
const PRIVACY_VERTICAL_CHROME = 43

type PrivacyResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West'

interface ReaderWindowSnapshot {
  innerSize: PhysicalSize
  outerSize: PhysicalSize
  position: PhysicalPosition
  scaleFactor: number
  maximized: boolean
  alwaysOnTop: boolean
  resizable: boolean
  maximizable: boolean
  minimizable: boolean
}

interface PrivacyWindowBounds {
  width: number
  height: number
  x: number
  y: number
}

let readerWindowSnapshot: ReaderWindowSnapshot | undefined

const bookId = computed(() => String(route.params.bookId))
const chapterNumber = computed(() => Number(route.params.chapterNumber))
const chapterIndex = computed(() => chapters.value.findIndex(item => item.number === chapter.value?.number))
const previous = computed(() => chapters.value[chapterIndex.value - 1])
const next = computed(() => chapters.value[chapterIndex.value + 1])
const volumeChapters = computed(() => chapter.value && isNumberedChapter(chapter.value)
  ? chapters.value.filter(item => isNumberedChapter(item) && item.volume === chapter.value?.volume)
  : [])
const volumeChapterIndex = computed(() => volumeChapters.value.findIndex(item => item.number === chapter.value?.number))
const paragraphs = computed(() => chapter.value?.content.split(/\n{2,}/).filter(Boolean) ?? [])
const isRichContent = computed(() => chapter.value?.contentFormat === 'html')
const safeRichContent = computed(() => isRichContent.value ? sanitizeReaderHtml(chapter.value?.content || '') : '')
const compactText = computed(() => chapter.value?.contentText || chapter.value?.content.replace(/<[^>]+>/gu, ' ') || '')
const privacyText = computed(() => {
  if (!chapter.value) return ''
  return buildPrivacyReaderText(
    isRichContent.value ? safeRichContent.value : chapter.value.content,
    chapter.value.contentFormat
  )
})
const compactWindow = computed(() => getCompactReaderWindow(compactText.value, compactAnchor.value, compactLines.value, compactColumns.value))
const privacyColumns = computed(() => Math.max(12, Math.floor(
  (privacyViewportWidth.value - PRIVACY_HORIZONTAL_PADDING) / (privacyFontSize.value * 1.02)
)))
const privacyLines = computed(() => Math.max(3, Math.floor(
  (privacyViewportHeight.value - PRIVACY_VERTICAL_CHROME) / (privacyFontSize.value * privacyLineHeight.value)
)))
const privacyWindow = computed(() => getCompactReaderWindow(privacyText.value, privacyAnchor.value, privacyLines.value, privacyColumns.value))
const privacyDefaultTextColor = computed(() => privacyPalette.value === 'light' ? '#252925' : '#ffffff')
const privacyTextColor = computed(() => privacyCustomTextColor.value || privacyDefaultTextColor.value)
const privacyStatusLabel = computed(() => {
  const position = chapterIndex.value >= 0 ? chapterIndex.value + 1 : 0
  const progress = privacyText.value.length ? Math.round(privacyAnchor.value / privacyText.value.length * 100) : 0
  return `${position}/${chapters.value.length} · ${progress}%`
})

function chapterDisplayLabel() {
  if (!chapter.value) return ''
  const label = formatChapterLabel(chapter.value)
  if (label !== chapter.value.title) return label
  const originalLabel = chapter.value.originalLabel.trim()
  if (/^(?:番外|楔子|序章|尾声)/u.test(originalLabel)) return originalLabel
  return ''
}

function chapterPositionLabel() {
  if (!chapter.value) return ''
  if (isNumberedChapter(chapter.value)) {
    const label = chapterDisplayLabel()
    return (label ? label + ' · ' : '') + '本卷 ' + (volumeChapterIndex.value + 1) + ' / ' + volumeChapters.value.length
  }
  const kindLabel = chapter.value.kind === 'volume' ? '分卷' : chapter.value.kind === 'frontmatter' ? '前置内容' : '附加内容'
  return kindLabel + ' · 全书 ' + (chapterIndex.value + 1) + ' / ' + chapters.value.length + ' 项'
}

function chapterHeading() {
  if (!chapter.value) return ''
  if (!isNumberedChapter(chapter.value)) return chapter.value.title
  const label = chapterDisplayLabel()
  return label ? `${label} ${chapter.value.title}` : chapter.value.title
}

function saveSettings() {
  localStorage.setItem('desktop-reader-settings', JSON.stringify({ fontSize: fontSize.value, lineHeight: lineHeight.value, palette: palette.value }))
}

function savePrivacySettings() {
  localStorage.setItem(PRIVACY_SETTINGS_STORAGE_KEY, JSON.stringify({
    fontSize: privacyFontSize.value,
    lineHeight: privacyLineHeight.value,
    textColors: privacyCustomTextColors.value
  }))
}

function setPrivacyTextColor(event: Event) {
  const input = event.target
  if (input instanceof HTMLInputElement) privacyCustomTextColor.value = input.value
}

function togglePrivacyPalette() {
  privacyPalette.value = privacyPalette.value === 'light' ? 'night' : 'light'
}

function preventPrivacyPointerFocus(event: MouseEvent) {
  if (!(event.target instanceof Element)) return
  const button = event.target.closest('button')
  if (button instanceof HTMLButtonElement) event.preventDefault()
}

async function togglePrivacyAlwaysOnTop() {
  const nextValue = !privacyAlwaysOnTop.value
  if (!isTauri()) {
    privacyAlwaysOnTop.value = nextValue
    return
  }
  try {
    await getCurrentWindow().setAlwaysOnTop(nextValue)
    privacyAlwaysOnTop.value = nextValue
  } catch (cause) {
    showGlobalError(cause, nextValue ? '窗口置顶失败，请稍后重试' : '取消窗口置顶失败，请稍后重试')
  }
}

function syncReaderChrome() {
  const activePalette = privacyMode.value ? privacyPalette.value : palette.value
  document.documentElement.dataset.readerPalette = activePalette
  void setWindowChrome(activePalette === 'night' ? 'dark' : 'light', activePalette)
}

function restoreApplicationChrome() {
  delete document.documentElement.dataset.readerPalette
  void syncApplicationWindowChrome()
}

function scrollProgress(element: HTMLElement | null | undefined) {
  if (!element) return 0
  const scrollable = element.scrollHeight - element.clientHeight
  return scrollable > 0 ? Math.min(1, Math.max(0, element.scrollTop / scrollable)) : 0
}

function startPrivacyDragging(event: MouseEvent) {
  const target = event.target
  if (target instanceof Element && !target.closest('.privacy-reader-settings, .privacy-reader-actions')) {
    privacySettingsOpen.value = false
  }
  if (!(target instanceof Element) || target.closest('button, a, input, textarea, select')) return
  if (!isTauri()) return
  event.preventDefault()
  void getCurrentWindow().startDragging().catch(error => console.warn('privacy-window-drag-failed', error))
}

function startPrivacyResize(direction: PrivacyResizeDirection) {
  if (!isTauri()) return
  void getCurrentWindow().startResizeDragging(direction).catch(error => console.warn('privacy-window-resize-failed', error))
}

function updatePrivacyViewport() {
  if (!privacyMode.value) return
  privacyViewportWidth.value = Math.max(PRIVACY_MIN_SIZE.width, window.innerWidth)
  privacyViewportHeight.value = Math.max(PRIVACY_MIN_SIZE.height, window.innerHeight)
}

function loadPrivacyWindowBounds(): PrivacyWindowBounds | undefined {
  try {
    const stored = JSON.parse(localStorage.getItem(PRIVACY_BOUNDS_STORAGE_KEY) || 'null') as Partial<PrivacyWindowBounds> | null
    if (!stored || ![stored.width, stored.height, stored.x, stored.y].every(Number.isFinite)) return undefined
    return {
      width: Math.max(PRIVACY_MIN_SIZE.width, Number(stored.width)),
      height: Math.max(PRIVACY_MIN_SIZE.height, Number(stored.height)),
      x: Number(stored.x),
      y: Number(stored.y)
    }
  } catch {
    return undefined
  }
}

function privacyPositionIsVisible(bounds: PrivacyWindowBounds, physicalWidth: number, physicalHeight: number, monitors: Awaited<ReturnType<typeof availableMonitors>>) {
  const minimumVisible = 48
  return monitors.some(monitor => {
    const left = monitor.workArea.position.x
    const top = monitor.workArea.position.y
    const right = left + monitor.workArea.size.width
    const bottom = top + monitor.workArea.size.height
    return bounds.x < right - minimumVisible
      && bounds.y < bottom - minimumVisible
      && bounds.x + physicalWidth > left + minimumVisible
      && bounds.y + physicalHeight > top + minimumVisible
  })
}

async function persistPrivacyWindowBounds() {
  if (!isTauri()) return
  const appWindow = getCurrentWindow()
  const [size, position, scaleFactor] = await Promise.all([
    appWindow.innerSize(),
    appWindow.outerPosition(),
    appWindow.scaleFactor()
  ])
  const logicalSize = size.toLogical(scaleFactor)
  localStorage.setItem(PRIVACY_BOUNDS_STORAGE_KEY, JSON.stringify({
    width: Math.max(PRIVACY_MIN_SIZE.width, Math.round(logicalSize.width)),
    height: Math.max(PRIVACY_MIN_SIZE.height, Math.round(logicalSize.height)),
    x: position.x,
    y: position.y
  } satisfies PrivacyWindowBounds))
}

function schedulePrivacyWindowBoundsSave() {
  if (!privacyMode.value || !isTauri()) return
  window.clearTimeout(privacyBoundsTimer)
  privacyBoundsTimer = window.setTimeout(() => {
    void persistPrivacyWindowBounds().catch(error => console.warn('privacy-window-bounds-save-failed', error))
  }, 180)
}

async function restoreReaderWindow() {
  if (!isTauri() || !readerWindowSnapshot) return
  const appWindow = getCurrentWindow()
  const snapshot = readerWindowSnapshot
  await appWindow.setAlwaysOnTop(snapshot.alwaysOnTop)
  await appWindow.setSkipTaskbar(false)
  // The application always uses its own titlebar. Privacy mode must restore the
  // normal window geometry without re-enabling the native Windows frame.
  await appWindow.setDecorations(false)
  await appWindow.setShadow(true)
  await appWindow.setResizable(snapshot.resizable)
  await appWindow.setMaximizable(snapshot.maximizable)
  await appWindow.setMinimizable(snapshot.minimizable)
  await appWindow.setMinSize(APPLICATION_MIN_SIZE)
  await appWindow.setSize(snapshot.innerSize)
  await appWindow.setPosition(snapshot.position)
  if (snapshot.maximized) await appWindow.maximize()
  readerWindowSnapshot = undefined
}

async function enterPrivacyMode(progressOverride?: number) {
  if (privacyMode.value) return
  const progress = typeof progressOverride === 'number'
    ? Math.min(1, Math.max(0, progressOverride))
    : compactMode.value && compactText.value.length
    ? compactAnchor.value / compactText.value.length
    : scrollProgress(scrollRoot)
  privacyAnchor.value = Math.floor(privacyText.value.length * progress)
  privacyAlwaysOnTop.value = false
  privacySettingsOpen.value = false
  privacyMode.value = true
  document.documentElement.dataset.readerPrivacy = 'true'
  syncReaderChrome()
  if (!isTauri()) {
    updatePrivacyViewport()
    return
  }

  const appWindow = getCurrentWindow()
  try {
    const [innerSize, outerSize, position, scaleFactor, maximized, alwaysOnTop, resizable, maximizable, minimizable, monitors] = await Promise.all([
      appWindow.innerSize(),
      appWindow.outerSize(),
      appWindow.outerPosition(),
      appWindow.scaleFactor(),
      appWindow.isMaximized(),
      appWindow.isAlwaysOnTop(),
      appWindow.isResizable(),
      appWindow.isMaximizable(),
      appWindow.isMinimizable(),
      availableMonitors()
    ])
    readerWindowSnapshot = { innerSize, outerSize, position, scaleFactor, maximized, alwaysOnTop, resizable, maximizable, minimizable }
    const storedBounds = loadPrivacyWindowBounds()
    const targetSize = new LogicalSize(
      storedBounds?.width ?? PRIVACY_DEFAULT_SIZE.width,
      storedBounds?.height ?? PRIVACY_DEFAULT_SIZE.height
    )
    const physicalWidth = targetSize.width * scaleFactor
    const physicalHeight = targetSize.height * scaleFactor
    const targetPosition = storedBounds && privacyPositionIsVisible(storedBounds, physicalWidth, physicalHeight, monitors)
      ? new PhysicalPosition(storedBounds.x, storedBounds.y)
      : new PhysicalPosition(
          Math.round(position.x + (outerSize.width - physicalWidth) / 2),
          Math.round(position.y + (outerSize.height - physicalHeight) / 2)
        )
    if (maximized) await appWindow.unmaximize()
    await appWindow.setAlwaysOnTop(false)
    await appWindow.setSkipTaskbar(true)
    await appWindow.setMinSize(PRIVACY_MIN_SIZE)
    await appWindow.setDecorations(false)
    await appWindow.setShadow(false)
    await appWindow.setResizable(true)
    await appWindow.setMaximizable(false)
    await appWindow.setMinimizable(false)
    await appWindow.setSize(targetSize)
    await appWindow.setPosition(targetPosition)
    await nextTick()
    updatePrivacyViewport()
    schedulePrivacyWindowBoundsSave()
  } catch (cause) {
    privacyMode.value = false
    delete document.documentElement.dataset.readerPrivacy
    syncReaderChrome()
    try {
      await restoreReaderWindow()
    } catch (restoreError) {
      console.warn('privacy-window-restore-failed', restoreError)
    }
    showGlobalError(cause, '隐私模式进入失败，请稍后重试')
  }
}

async function leavePrivacyMode() {
  if (!privacyMode.value) return
  const progress = privacyText.value.length ? privacyAnchor.value / privacyText.value.length : 0
  compactAnchor.value = Math.floor(compactText.value.length * progress)
  void persistProgress(progress * 100)
  try {
    await persistPrivacyWindowBounds()
  } catch (error) {
    console.warn('privacy-window-bounds-save-failed', error)
  }
  privacyMode.value = false
  privacyAlwaysOnTop.value = false
  privacySettingsOpen.value = false
  delete document.documentElement.dataset.readerPrivacy
  syncReaderChrome()
  try {
    await restoreReaderWindow()
  } catch (cause) {
    showGlobalError(cause, '普通阅读窗口恢复失败，请重启应用后重试')
  }
  if (!compactMode.value && scrollRoot && compactText.value.length) {
    await nextTick()
    window.requestAnimationFrame(() => {
      if (!scrollRoot) return
      scrollRoot.scrollTo({ top: (scrollRoot.scrollHeight - scrollRoot.clientHeight) * progress })
    })
  }
}

async function persistProgress(progress: number) {
  if (!chapter.value) return
  try {
    await saveDesktopProgress(bookId.value, chapter.value.number, progress)
    progressSaveFailed = false
  } catch (cause) {
    if (!progressSaveFailed) {
      showGlobalError(cause, '阅读进度保存失败，请稍后重试')
    }
    progressSaveFailed = true
  }
}

function updateProgress() {
  if (!scrollRoot || !chapter.value) return
  const scrollable = scrollRoot.scrollHeight - scrollRoot.clientHeight
  const progress = scrollable > 0 ? Math.min(100, Math.max(0, scrollRoot.scrollTop / scrollable * 100)) : 0
  window.clearTimeout(progressTimer)
  progressTimer = window.setTimeout(() => void persistProgress(progress), 450)
}

function saveCompactProgress() {
  if (!chapter.value) return
  const activeText = privacyMode.value ? privacyText.value : compactText.value
  const activeAnchor = privacyMode.value ? privacyAnchor.value : compactAnchor.value
  const progress = activeText.length ? activeAnchor / activeText.length * 100 : 0
  window.clearTimeout(progressTimer)
  progressTimer = window.setTimeout(() => void persistProgress(progress), 300)
}

function moveCompactWindow(direction: -1 | 1, page = false) {
  if ((!compactMode.value && !privacyMode.value) || (!compactText.value.length && !privacyText.value.length)) return
  const activeWindow = privacyMode.value ? privacyWindow.value : compactWindow.value
  const activeText = privacyMode.value ? privacyText.value : compactText.value
  const visibleLines = privacyMode.value ? privacyLines.value : compactLines.value
  const columns = privacyMode.value ? privacyColumns.value : compactColumns.value
  if (!activeWindow.lines.length) return
  const step = page ? visibleLines : 1
  const target = activeWindow.startLine + direction * step
  const allLines = getCompactReaderWindow(activeText, Number.MAX_SAFE_INTEGER, 1, columns)
  const maxLine = Math.max(0, allLines.totalLines - visibleLines)
  const targetLine = Math.min(maxLine, Math.max(0, target))
  const line = getCompactReaderWindow(activeText, 0, maxLine + 1, columns).lines[targetLine]
  if (line) {
    if (privacyMode.value) privacyAnchor.value = line.start
    else compactAnchor.value = line.start
    saveCompactProgress()
  }
}

function handlePrivacyWheel(event: WheelEvent) {
  if (!event.deltaY) return
  moveCompactWindow(event.deltaY > 0 ? 1 : -1)
}

function handleReaderKeydown(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
  if (privacyMode.value && event.key === 'Escape') {
    event.preventDefault()
    if (privacySettingsOpen.value) {
      privacySettingsOpen.value = false
      return
    }
    void leavePrivacyMode()
    return
  }
  if (privacyMode.value && event.key === 'F12') {
    event.preventDefault()
    togglePrivacyPalette()
    return
  }
  if (event.ctrlKey && event.key === 'ArrowRight') {
    event.preventDefault()
    if (next.value) openChapter(next.value.number)
    return
  }
  if (event.ctrlKey && event.key === 'ArrowLeft') {
    event.preventDefault()
    if (previous.value) openChapter(previous.value.number)
    return
  }
  if (privacyMode.value) {
    const directionCode = event.ctrlKey || event.altKey || event.metaKey ? '' : event.code
    if (event.key === 'ArrowRight' || directionCode === 'KeyD') {
      event.preventDefault()
      if (next.value) openChapter(next.value.number)
    } else if (event.key === 'ArrowLeft' || directionCode === 'KeyA') {
      event.preventDefault()
      if (previous.value) openChapter(previous.value.number)
    } else if (event.key === 'ArrowDown' || directionCode === 'KeyS' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault()
      moveCompactWindow(1, event.key === 'PageDown' || event.key === ' ')
    } else if (event.key === 'ArrowUp' || directionCode === 'KeyW' || event.key === 'PageUp') {
      event.preventDefault()
      moveCompactWindow(-1, event.key === 'PageUp')
    }
    return
  }
  if (!compactMode.value) return
  if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
    event.preventDefault()
    moveCompactWindow(1, event.key !== 'ArrowDown')
  } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
    event.preventDefault()
    moveCompactWindow(-1, event.key !== 'ArrowUp')
  } else if (event.key === 'Escape' && compactMode.value) {
    compactMode.value = false
  }
}

async function load() {
  loading.value = true
  try {
    const [nextBook, nextChapters, nextChapter] = await Promise.all([
      getDesktopBook(bookId.value),
      listDesktopChapters(bookId.value),
      getDesktopChapter(bookId.value, chapterNumber.value)
    ])
    if (!nextBook || !nextChapter) throw new Error('章节不存在或已被删除')
    book.value = nextBook
    chapters.value = nextChapters
    chapter.value = nextChapter
    const restoredProgress = nextBook.currentChapter === nextChapter.number ? nextBook.chapterProgress : 0
    compactAnchor.value = Math.floor(compactText.value.length * restoredProgress / 100)
    privacyAnchor.value = Math.floor(privacyText.value.length * restoredProgress / 100)
    await nextTick()
    if (route.query.privacy === '1' && !privacyMode.value) {
      await enterPrivacyMode(restoredProgress / 100)
      const query = { ...route.query }
      delete query.privacy
      void router.replace({ query })
      return
    }
    window.requestAnimationFrame(() => {
      if (!scrollRoot || privacyMode.value) return
      const scrollable = scrollRoot.scrollHeight - scrollRoot.clientHeight
      scrollRoot.scrollTo({ top: scrollable * restoredProgress / 100 })
    })
  } catch (cause) {
    showGlobalError(cause, '章节加载失败，请返回目录后重试')
  } finally {
    loading.value = false
  }
}

function openChapter(number: number) {
  router.push(`/read/${bookId.value}/${number}`)
}

onMounted(() => {
  try {
    const stored = JSON.parse(localStorage.getItem('desktop-reader-settings') || '{}')
    if (stored.fontSize) fontSize.value = stored.fontSize
    if (stored.lineHeight) lineHeight.value = stored.lineHeight
    if (stored.palette) palette.value = stored.palette
  } catch {}
  privacyPalette.value = localStorage.getItem('desktop-reader-privacy-palette') === 'night' ? 'night' : 'light'
  try {
    const storedPrivacy = JSON.parse(localStorage.getItem(PRIVACY_SETTINGS_STORAGE_KEY) || '{}')
    if (Number.isFinite(storedPrivacy.fontSize)) privacyFontSize.value = Math.min(20, Math.max(10, storedPrivacy.fontSize))
    if ([1.7, 1.9, 2.1].includes(storedPrivacy.lineHeight)) privacyLineHeight.value = storedPrivacy.lineHeight
    const storedTextColors = storedPrivacy.textColors
    if (storedTextColors && typeof storedTextColors === 'object') {
      privacyCustomTextColors.value = {
        light: typeof storedTextColors.light === 'string' && /^#[0-9a-f]{6}$/iu.test(storedTextColors.light) ? storedTextColors.light : '',
        night: typeof storedTextColors.night === 'string' && /^#[0-9a-f]{6}$/iu.test(storedTextColors.night) ? storedTextColors.night : ''
      }
    }
  } catch {}
  savePrivacySettings()
  syncReaderChrome()
  scrollRoot = document.querySelector('.app-workspace')
  scrollRoot?.addEventListener('scroll', updateProgress, { passive: true })
  window.addEventListener('keydown', handleReaderKeydown)
  window.addEventListener('resize', updatePrivacyViewport)
  if (isTauri()) {
    const appWindow = getCurrentWindow()
    void appWindow.onResized(() => {
      updatePrivacyViewport()
      schedulePrivacyWindowBoundsSave()
    }).then(unlisten => { unlistenPrivacyResize = unlisten })
    void appWindow.onMoved(schedulePrivacyWindowBoundsSave).then(unlisten => { unlistenPrivacyMove = unlisten })
  }
  void load()
})
onBeforeUnmount(() => {
  const privacyRestore = privacyMode.value
    ? persistPrivacyWindowBounds().catch(error => console.warn('privacy-window-bounds-save-failed', error)).then(restoreReaderWindow)
    : Promise.resolve()
  privacyMode.value = false
  delete document.documentElement.dataset.readerPrivacy
  restoreApplicationChrome()
  void privacyRestore
    .catch(error => console.warn('privacy-window-restore-failed', error))
  scrollRoot?.removeEventListener('scroll', updateProgress)
  window.removeEventListener('keydown', handleReaderKeydown)
  window.removeEventListener('resize', updatePrivacyViewport)
  unlistenPrivacyResize?.()
  unlistenPrivacyMove?.()
  window.clearTimeout(progressTimer)
  window.clearTimeout(privacyBoundsTimer)
})
watch([fontSize, lineHeight, palette], saveSettings)
watch([palette, privacyPalette], syncReaderChrome)
watch(privacyPalette, value => localStorage.setItem('desktop-reader-privacy-palette', value))
watch([privacyFontSize, privacyLineHeight, privacyCustomTextColor], savePrivacySettings)
watch(() => route.params.chapterNumber, load)
</script>

<template>
  <section
    class="desktop-reader"
    :class="[
      `desktop-reader--${privacyMode ? privacyPalette : palette}`,
      { 'desktop-reader--compact': compactMode, 'desktop-reader--privacy': privacyMode }
    ]"
    :style="{
      '--reader-font-size': `${privacyMode ? privacyFontSize : fontSize}px`,
      '--reader-line-height': privacyMode ? privacyLineHeight : lineHeight,
      '--privacy-visible-lines': privacyLines,
      '--privacy-text-color': privacyTextColor
    }"
  >
    <main v-if="privacyMode" class="privacy-reader" aria-label="隐私阅读模式" @mousedown.left="startPrivacyDragging" @mouseleave="privacySettingsOpen = false" @wheel.prevent="handlePrivacyWheel">
      <span class="privacy-resize-handle privacy-resize-handle--north" aria-hidden="true" @mousedown.left.stop.prevent="startPrivacyResize('North')" />
      <span class="privacy-resize-handle privacy-resize-handle--south" aria-hidden="true" @mousedown.left.stop.prevent="startPrivacyResize('South')" />
      <span class="privacy-resize-handle privacy-resize-handle--east" aria-hidden="true" @mousedown.left.stop.prevent="startPrivacyResize('East')" />
      <span class="privacy-resize-handle privacy-resize-handle--west" aria-hidden="true" @mousedown.left.stop.prevent="startPrivacyResize('West')" />
      <span class="privacy-resize-handle privacy-resize-handle--north-east" aria-hidden="true" @mousedown.left.stop.prevent="startPrivacyResize('NorthEast')" />
      <span class="privacy-resize-handle privacy-resize-handle--north-west" aria-hidden="true" @mousedown.left.stop.prevent="startPrivacyResize('NorthWest')" />
      <span class="privacy-resize-handle privacy-resize-handle--south-east" aria-hidden="true" @mousedown.left.stop.prevent="startPrivacyResize('SouthEast')" />
      <span class="privacy-resize-handle privacy-resize-handle--south-west" aria-hidden="true" @mousedown.left.stop.prevent="startPrivacyResize('SouthWest')" />
      <div class="privacy-reader-lines">
        <p v-for="line in privacyWindow.lines" :key="line.start">{{ line.text || ' ' }}</p>
      </div>
      <div class="privacy-reader-chapter-controls" @mousedown.stop="preventPrivacyPointerFocus">
        <small class="privacy-reader-status" title="当前章节 / 总章节 · 本章进度">{{ privacyStatusLabel }}</small>
        <button
          type="button"
          title="上一章（← / A）"
          aria-label="上一章"
          aria-keyshortcuts="ArrowLeft A"
          :disabled="!previous"
          @click="previous && openChapter(previous.number)"
        >
          <ChevronLeft :size="14" />
        </button>
        <button
          type="button"
          title="下一章（→ / D）"
          aria-label="下一章"
          aria-keyshortcuts="ArrowRight D"
          :disabled="!next"
          @click="next && openChapter(next.number)"
        >
          <ChevronRight :size="14" />
        </button>
      </div>
      <div v-if="privacySettingsOpen" class="privacy-reader-settings" role="dialog" aria-label="隐私阅读设置" @mousedown.stop="preventPrivacyPointerFocus" @wheel.stop>
        <div class="privacy-setting-row">
          <span>字号</span>
          <div class="privacy-setting-stepper">
            <button type="button" title="减小字号" :disabled="privacyFontSize <= 10" @click="privacyFontSize = Math.max(10, privacyFontSize - 1)"><Minus :size="12" /></button>
            <output>{{ privacyFontSize }}</output>
            <button type="button" title="增大字号" :disabled="privacyFontSize >= 20" @click="privacyFontSize = Math.min(20, privacyFontSize + 1)"><Plus :size="12" /></button>
          </div>
        </div>
        <div class="privacy-setting-row">
          <span>行距</span>
          <div class="privacy-setting-segments">
            <button v-for="item in ([['紧', 1.7], ['中', 1.9], ['松', 2.1]] as const)" :key="item[0]" type="button" :class="{ active: privacyLineHeight === item[1] }" @click="privacyLineHeight = item[1]">{{ item[0] }}</button>
          </div>
        </div>
        <div class="privacy-setting-row">
          <span>文字</span>
          <div class="privacy-setting-color-picker">
            <input type="color" :value="privacyTextColor" title="选择文字颜色" aria-label="选择文字颜色" @input="setPrivacyTextColor" />
            <button type="button" title="恢复默认文字颜色" aria-label="恢复默认文字颜色" :disabled="!privacyCustomTextColor" @click="privacyCustomTextColor = ''"><RotateCcw :size="12" /></button>
          </div>
        </div>
      </div>
      <div class="privacy-reader-actions" @mousedown.stop="preventPrivacyPointerFocus">
        <button
          type="button"
          :class="{ active: privacySettingsOpen }"
          title="隐私阅读设置"
          aria-label="隐私阅读设置"
          :aria-expanded="privacySettingsOpen"
          @click="privacySettingsOpen = !privacySettingsOpen"
        >
          <Settings2 :size="14" />
        </button>
        <button
          type="button"
          :class="{ active: privacyAlwaysOnTop }"
          :title="privacyAlwaysOnTop ? '取消窗口置顶' : '窗口置顶'"
          :aria-label="privacyAlwaysOnTop ? '取消窗口置顶' : '窗口置顶'"
          :aria-pressed="privacyAlwaysOnTop"
          @click="togglePrivacyAlwaysOnTop"
        >
          <Pin :size="14" />
        </button>
        <button
          type="button"
          :title="privacyPalette === 'light' ? '切换到黑夜（F12）' : '切换到白色（F12）'"
          :aria-label="privacyPalette === 'light' ? '切换到黑夜' : '切换到白色'"
          @click="togglePrivacyPalette"
        >
          <Moon v-if="privacyPalette === 'light'" :size="14" />
          <Sun v-else :size="14" />
        </button>
        <button type="button" title="退出隐私模式（Esc）" aria-label="退出隐私模式" @click="leavePrivacyMode">
          <LogOut :size="14" />
        </button>
      </div>
    </main>

    <template v-else>
      <header class="desktop-reader-toolbar"><button type="button" class="icon-button" title="返回目录" @click="router.push(`/book/${bookId}`)"><ArrowLeft :size="18" /></button><div v-if="book && chapter"><strong>{{ book.title }}</strong><span>{{ chapterPositionLabel() }}</span></div><div class="reader-controls"><button type="button" class="reader-privacy-toggle" title="进入隐私模式" @click="enterPrivacyMode()"><EyeOff :size="14" /><span>隐私</span></button><button type="button" :class="{ active: compactMode }" title="紧凑阅读模式" @click="compactMode = !compactMode">{{ compactMode ? '完整' : '紧凑' }}</button><label v-if="compactMode" class="reader-compact-lines" title="显示行数"><button v-for="value in [4, 5, 8]" :key="value" type="button" :class="{ active: compactLines === value }" @click="compactLines = value">{{ value }} 行</button></label><label class="reader-font-size" title="字号"><Type :size="16" /><button type="button" @click="fontSize = Math.max(15, fontSize - 1)"><Minus :size="14" /></button><output>{{ fontSize }}</output><button type="button" @click="fontSize = Math.min(26, fontSize + 1)"><Plus :size="14" /></button></label><label class="reader-line-height" title="行距"><AlignJustify :size="16" /><button v-for="value in [1.8, 2.05, 2.3]" :key="value" type="button" :class="{ active: lineHeight === value }" @click="lineHeight = value">{{ value === 1.8 ? '紧' : value === 2.05 ? '中' : '松' }}</button></label><label class="reader-palette" title="纸张"><Sun :size="16" /><button v-for="item in ([['light','白'],['paper','纸'],['night','夜']] as const)" :key="item[0]" type="button" :class="{ active: palette === item[0] }" @click="palette = item[0]">{{ item[1] }}</button></label></div></header>
      <div v-if="loading" class="view-status" role="status">正在加载章节...</div>
      <main v-else-if="book && chapter" :class="compactMode ? 'desktop-reader-compact-content' : 'desktop-reader-content'"><article><p v-if="chapter.kind !== 'volume'" class="reader-volume">{{ chapter.volume || book.title }}</p><h1>{{ chapterHeading() }}</h1><section v-if="compactMode" class="compact-reader-window"><p v-for="line in compactWindow.lines" :key="line.start">{{ line.text || ' ' }}</p><small>{{ compactWindow.startLine + 1 }} - {{ compactWindow.endLine }} / {{ compactWindow.totalLines }} 行</small></section><template v-else><div v-if="isRichContent" class="epub-content" v-html="safeRichContent" /><template v-else><p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p></template></template></article><footer><button type="button" :disabled="!previous" @click="previous && openChapter(previous.number)"><ChevronLeft :size="18" /><span><small>上一章</small>{{ previous?.title || '已经是第一章' }}</span></button><button type="button" :disabled="!next" @click="next && openChapter(next.number)"><span><small>下一章</small>{{ next?.title || '已经是最后一章' }}</span><ChevronRight :size="18" /></button></footer></main>
    </template>
  </section>
</template>
