<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { AlignJustify, ArrowLeft, ChevronLeft, ChevronRight, EyeOff, LogOut, Minus, Moon, Plus, Sun, Type } from 'lucide-vue-next'
import { formatChapterLabel, getCompactReaderWindow, isNumberedChapter } from '@novel-library/reader-core'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { LogicalSize, PhysicalPosition, type PhysicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow, type Theme } from '@tauri-apps/api/window'
import { getDesktopBook, getDesktopChapter, listDesktopChapters, saveDesktopProgress, type DesktopBook, type DesktopChapter, type DesktopChapterSummary } from '../services/desktop-library'
import { sanitizeReaderHtml } from '../services/sanitize-reader-html'
import { showGlobalError } from '../services/global-message'

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
const privacyPalette = ref<'light' | 'night'>('light')
let scrollRoot: HTMLElement | null = null
let progressTimer = 0
let progressSaveFailed = false

const READER_MIN_SIZE = new LogicalSize(520, 360)
const APPLICATION_MIN_SIZE = new LogicalSize(760, 560)
const PRIVACY_WINDOW_SIZE = new LogicalSize(300, 200)
const PRIVACY_FONT_SIZE = 12
const PRIVACY_LINE_HEIGHT = 1.9
const PRIVACY_COLUMNS = 22
const PRIVACY_LINES = 6

interface ReaderWindowSnapshot {
  innerSize: PhysicalSize
  outerSize: PhysicalSize
  position: PhysicalPosition
  scaleFactor: number
  maximized: boolean
  resizable: boolean
  maximizable: boolean
  minimizable: boolean
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
  if (!isRichContent.value) {
    return chapter.value.content
      .split(/\n{2,}/u)
      .map(paragraph => paragraph.replace(/\s*\n\s*/gu, '').trim())
      .filter(Boolean)
      .map(paragraph => `　　${paragraph}`)
      .join('\n')
  }

  const document = new DOMParser().parseFromString(safeRichContent.value, 'text/html')
  const blockSelector = 'h1, h2, h3, h4, h5, h6, p, blockquote, li, figcaption, pre, td, th'
  return Array.from(document.body.querySelectorAll(blockSelector))
    .filter(element => !element.querySelector(blockSelector))
    .map(element => {
      const text = (element.textContent || '').replace(/\s+/gu, ' ').trim()
      if (!text) return ''
      if (element.tagName === 'LI') return `· ${text}`
      const heading = /^H[1-6]$/u.test(element.tagName) || (text.length <= 20 && !/[。！？!?；;：:]$/u.test(text))
      return heading ? text : `　　${text}`
    })
    .filter(Boolean)
    .join('\n')
})
const compactWindow = computed(() => getCompactReaderWindow(compactText.value, compactAnchor.value, compactLines.value, compactColumns.value))
const privacyWindow = computed(() => getCompactReaderWindow(privacyText.value, privacyAnchor.value, PRIVACY_LINES, PRIVACY_COLUMNS))
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

function togglePrivacyPalette() {
  privacyPalette.value = privacyPalette.value === 'light' ? 'night' : 'light'
}

function appearanceWindowTheme(): Theme | null {
  const appearance = document.documentElement.dataset.appearance
  return appearance === 'dark' ? 'dark' : appearance === 'light' ? 'light' : null
}

async function setWindowChrome(theme: Theme | null, readerPalette?: typeof palette.value) {
  if (!isTauri()) return
  try {
    await getCurrentWindow().setTheme(theme)
    await invoke('set_reader_window_palette', { palette: readerPalette ?? null })
  } catch (error) {
    console.warn('window-theme-update-failed', error)
  }
}

function syncReaderChrome() {
  const activePalette = privacyMode.value ? privacyPalette.value : palette.value
  document.documentElement.dataset.readerPalette = activePalette
  void setWindowChrome(activePalette === 'night' ? 'dark' : 'light', activePalette)
}

function restoreApplicationChrome() {
  delete document.documentElement.dataset.readerPalette
  void setWindowChrome(appearanceWindowTheme())
}

async function setReaderSizeLimit(reading: boolean) {
  if (!isTauri()) return
  const appWindow = getCurrentWindow()
  try {
    await appWindow.setMinSize(reading ? READER_MIN_SIZE : APPLICATION_MIN_SIZE)
    if (!reading) {
      const [physicalSize, scaleFactor] = await Promise.all([appWindow.innerSize(), appWindow.scaleFactor()])
      const logicalSize = physicalSize.toLogical(scaleFactor)
      if (logicalSize.width < APPLICATION_MIN_SIZE.width || logicalSize.height < APPLICATION_MIN_SIZE.height) {
        await appWindow.setSize(new LogicalSize(
          Math.max(logicalSize.width, APPLICATION_MIN_SIZE.width),
          Math.max(logicalSize.height, APPLICATION_MIN_SIZE.height)
        ))
      }
    }
  } catch (error) {
    console.warn('window-size-update-failed', error)
  }
}

function scrollProgress(element: HTMLElement | null | undefined) {
  if (!element) return 0
  const scrollable = element.scrollHeight - element.clientHeight
  return scrollable > 0 ? Math.min(1, Math.max(0, element.scrollTop / scrollable)) : 0
}

function startPrivacyDragging(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element) || target.closest('button, a, input, textarea, select')) return
  if (!isTauri()) return
  event.preventDefault()
  void getCurrentWindow().startDragging().catch(error => console.warn('privacy-window-drag-failed', error))
}

async function restoreReaderWindow() {
  if (!isTauri() || !readerWindowSnapshot) return
  const appWindow = getCurrentWindow()
  const snapshot = readerWindowSnapshot
  await appWindow.setDecorations(true)
  await appWindow.setShadow(true)
  await appWindow.setResizable(snapshot.resizable)
  await appWindow.setMaximizable(snapshot.maximizable)
  await appWindow.setMinimizable(snapshot.minimizable)
  await appWindow.setMinSize(READER_MIN_SIZE)
  await appWindow.setSize(snapshot.innerSize)
  await appWindow.setPosition(snapshot.position)
  if (snapshot.maximized) await appWindow.maximize()
  readerWindowSnapshot = undefined
}

async function enterPrivacyMode() {
  if (privacyMode.value) return
  const progress = compactMode.value && compactText.value.length
    ? compactAnchor.value / compactText.value.length
    : scrollProgress(scrollRoot)
  privacyAnchor.value = Math.floor(privacyText.value.length * progress)
  privacyMode.value = true
  document.documentElement.dataset.readerPrivacy = 'true'
  syncReaderChrome()
  if (!isTauri()) return

  const appWindow = getCurrentWindow()
  try {
    const [innerSize, outerSize, position, scaleFactor, maximized, resizable, maximizable, minimizable] = await Promise.all([
      appWindow.innerSize(),
      appWindow.outerSize(),
      appWindow.outerPosition(),
      appWindow.scaleFactor(),
      appWindow.isMaximized(),
      appWindow.isResizable(),
      appWindow.isMaximizable(),
      appWindow.isMinimizable()
    ])
    readerWindowSnapshot = { innerSize, outerSize, position, scaleFactor, maximized, resizable, maximizable, minimizable }
    if (maximized) await appWindow.unmaximize()
    await appWindow.setMinSize(PRIVACY_WINDOW_SIZE)
    await appWindow.setDecorations(false)
    await appWindow.setShadow(false)
    await appWindow.setResizable(false)
    await appWindow.setMaximizable(false)
    await appWindow.setMinimizable(false)
    await appWindow.setSize(PRIVACY_WINDOW_SIZE)
    await appWindow.setPosition(new PhysicalPosition(
      Math.round(position.x + (outerSize.width - PRIVACY_WINDOW_SIZE.width * scaleFactor) / 2),
      Math.round(position.y + (outerSize.height - PRIVACY_WINDOW_SIZE.height * scaleFactor) / 2)
    ))
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
  privacyMode.value = false
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
  const visibleLines = privacyMode.value ? PRIVACY_LINES : compactLines.value
  const columns = privacyMode.value ? PRIVACY_COLUMNS : compactColumns.value
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
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (next.value) openChapter(next.value.number)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (previous.value) openChapter(previous.value.number)
    } else if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault()
      moveCompactWindow(1, event.key !== 'ArrowDown')
    } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
      event.preventDefault()
      moveCompactWindow(-1, event.key !== 'ArrowUp')
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
  syncReaderChrome()
  void setReaderSizeLimit(true)
  scrollRoot = document.querySelector('.app-workspace')
  scrollRoot?.addEventListener('scroll', updateProgress, { passive: true })
  window.addEventListener('keydown', handleReaderKeydown)
  load()
})
onBeforeUnmount(() => {
  const privacyRestore = privacyMode.value ? restoreReaderWindow() : Promise.resolve()
  privacyMode.value = false
  delete document.documentElement.dataset.readerPrivacy
  restoreApplicationChrome()
  void privacyRestore
    .catch(error => console.warn('privacy-window-restore-failed', error))
    .finally(() => setReaderSizeLimit(false))
  scrollRoot?.removeEventListener('scroll', updateProgress)
  window.removeEventListener('keydown', handleReaderKeydown)
  window.clearTimeout(progressTimer)
})
watch([fontSize, lineHeight, palette], saveSettings)
watch([palette, privacyPalette], syncReaderChrome)
watch(privacyPalette, value => localStorage.setItem('desktop-reader-privacy-palette', value))
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
      '--reader-font-size': `${privacyMode ? PRIVACY_FONT_SIZE : fontSize}px`,
      '--reader-line-height': privacyMode ? PRIVACY_LINE_HEIGHT : lineHeight
    }"
  >
    <main v-if="privacyMode" class="privacy-reader" aria-label="隐私阅读模式" @mousedown.left="startPrivacyDragging" @wheel.prevent="handlePrivacyWheel">
      <div class="privacy-reader-lines">
        <p v-for="line in privacyWindow.lines" :key="line.start">{{ line.text || ' ' }}</p>
      </div>
      <div class="privacy-reader-chapter-controls">
        <small class="privacy-reader-status" title="当前章节 / 总章节 · 本章进度">{{ privacyStatusLabel }}</small>
        <button
          type="button"
          title="上一章（←）"
          aria-label="上一章"
          :disabled="!previous"
          @click="previous && openChapter(previous.number)"
        >
          <ChevronLeft :size="14" />
        </button>
        <button
          type="button"
          title="下一章（→）"
          aria-label="下一章"
          :disabled="!next"
          @click="next && openChapter(next.number)"
        >
          <ChevronRight :size="14" />
        </button>
      </div>
      <div class="privacy-reader-actions">
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
      <header class="desktop-reader-toolbar"><button type="button" class="icon-button" title="返回目录" @click="router.push(`/book/${bookId}`)"><ArrowLeft :size="18" /></button><div v-if="book && chapter"><strong>{{ book.title }}</strong><span>{{ chapterPositionLabel() }}</span></div><div class="reader-controls"><button type="button" class="reader-privacy-toggle" title="进入隐私模式" @click="enterPrivacyMode"><EyeOff :size="14" /><span>隐私</span></button><button type="button" :class="{ active: compactMode }" title="紧凑阅读模式" @click="compactMode = !compactMode">{{ compactMode ? '完整' : '紧凑' }}</button><label v-if="compactMode" class="reader-compact-lines" title="显示行数"><button v-for="value in [4, 5, 8]" :key="value" type="button" :class="{ active: compactLines === value }" @click="compactLines = value">{{ value }} 行</button></label><label class="reader-font-size" title="字号"><Type :size="16" /><button type="button" @click="fontSize = Math.max(15, fontSize - 1)"><Minus :size="14" /></button><output>{{ fontSize }}</output><button type="button" @click="fontSize = Math.min(26, fontSize + 1)"><Plus :size="14" /></button></label><label class="reader-line-height" title="行距"><AlignJustify :size="16" /><button v-for="value in [1.8, 2.05, 2.3]" :key="value" type="button" :class="{ active: lineHeight === value }" @click="lineHeight = value">{{ value === 1.8 ? '紧' : value === 2.05 ? '中' : '松' }}</button></label><label class="reader-palette" title="纸张"><Sun :size="16" /><button v-for="item in ([['light','白'],['paper','纸'],['night','夜']] as const)" :key="item[0]" type="button" :class="{ active: palette === item[0] }" @click="palette = item[0]">{{ item[1] }}</button></label></div></header>
      <div v-if="loading" class="view-status" role="status">正在加载章节...</div>
      <main v-else-if="book && chapter" :class="compactMode ? 'desktop-reader-compact-content' : 'desktop-reader-content'"><article><p v-if="chapter.kind !== 'volume'" class="reader-volume">{{ chapter.volume || book.title }}</p><h1>{{ chapterHeading() }}</h1><section v-if="compactMode" class="compact-reader-window"><p v-for="line in compactWindow.lines" :key="line.start">{{ line.text || ' ' }}</p><small>{{ compactWindow.startLine + 1 }} - {{ compactWindow.endLine }} / {{ compactWindow.totalLines }} 行</small></section><template v-else><div v-if="isRichContent" class="epub-content" v-html="safeRichContent" /><template v-else><p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p></template></template></article><footer><button type="button" :disabled="!previous" @click="previous && openChapter(previous.number)"><ChevronLeft :size="18" /><span><small>上一章</small>{{ previous?.title || '已经是第一章' }}</span></button><button type="button" :disabled="!next" @click="next && openChapter(next.number)"><span><small>下一章</small>{{ next?.title || '已经是最后一章' }}</span><ChevronRight :size="18" /></button></footer></main>
    </template>
  </section>
</template>
