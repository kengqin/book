import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

export const SIDEBAR_MIN_WIDTH = 176
export const SIDEBAR_MAX_WIDTH = 320
export const SIDEBAR_DEFAULT_WIDTH = 218
export const SIDEBAR_WIDTH_STORAGE_KEY = 'novel-library-sidebar-width'

export function clampSidebarWidth(width: number) {
  return Number.isFinite(width)
    ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
    : SIDEBAR_DEFAULT_WIDTH
}

export function useSidebarResize(enabled: Ref<boolean>) {
  function storedWidth() {
    try {
      const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
      return stored?.trim() ? clampSidebarWidth(Number(stored)) : SIDEBAR_DEFAULT_WIDTH
    } catch {
      return SIDEBAR_DEFAULT_WIDTH
    }
  }

  const sidebarWidth = ref(storedWidth())
  const sidebarResizing = ref(false)
  let activePointer: number | undefined
  let startX = 0
  let startWidth = sidebarWidth.value
  let handle: HTMLElement | undefined

  function persistWidth() {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth.value))
    } catch { /* Resizing still works when storage is unavailable. */ }
  }

  function move(event: PointerEvent) {
    if (event.pointerId !== activePointer) return
    sidebarWidth.value = clampSidebarWidth(startWidth + event.clientX - startX)
  }

  function stop(event?: PointerEvent) {
    if (event && event.pointerId !== activePointer) return
    if (activePointer !== undefined && handle?.hasPointerCapture(activePointer)) {
      handle.releasePointerCapture(activePointer)
    }
    if (sidebarResizing.value) persistWidth()
    activePointer = undefined
    handle = undefined
    sidebarResizing.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    window.removeEventListener('blur', onBlur)
  }

  function onBlur() { stop() }

  function startSidebarResize(event: PointerEvent) {
    if (!enabled.value || event.button !== 0 || sidebarResizing.value) return
    if (!(event.currentTarget instanceof HTMLElement)) return
    event.preventDefault()
    handle = event.currentTarget
    handle.focus()
    activePointer = event.pointerId
    startX = event.clientX
    startWidth = sidebarWidth.value
    handle.setPointerCapture(activePointer)
    sidebarResizing.value = true
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', onBlur)
  }

  function resizeSidebarWithKeyboard(event: KeyboardEvent) {
    if (!enabled.value || sidebarResizing.value) return
    const widths: Record<string, number> = {
      ArrowLeft: sidebarWidth.value - 8,
      ArrowRight: sidebarWidth.value + 8,
      Home: SIDEBAR_MIN_WIDTH,
      End: SIDEBAR_MAX_WIDTH,
    }
    if (!(event.key in widths)) return
    event.preventDefault()
    sidebarWidth.value = clampSidebarWidth(widths[event.key])
    persistWidth()
  }

  watch(enabled, value => { if (!value) stop() })
  onBeforeUnmount(() => stop())

  return { sidebarWidth, sidebarResizing, startSidebarResize, resizeSidebarWithKeyboard }
}
