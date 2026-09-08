// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import {
  clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY, useSidebarResize,
} from './useSidebarResize'

const cleanups: (() => void)[] = []

function mountResize() {
  const enabled = ref(true)
  let resize!: ReturnType<typeof useSidebarResize>
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup() {
      resize = useSidebarResize(enabled)
      return () => h('div', { tabindex: 0, onPointerdown: resize.startSidebarResize })
    },
  })
  app.mount(root)
  const handle = root.firstElementChild as HTMLElement
  let captured: number | undefined
  handle.setPointerCapture = vi.fn(id => { captured = id })
  handle.hasPointerCapture = vi.fn(id => captured === id)
  handle.releasePointerCapture = vi.fn(() => { captured = undefined })
  const unmount = () => { app.unmount(); root.remove() }
  cleanups.push(unmount)
  return { resize, enabled, handle, unmount }
}

function pointer(target: EventTarget, type: string, clientX: number, pointerId = 1, button = 0) {
  target.dispatchEvent(Object.assign(new MouseEvent(type, { clientX, button, bubbles: true, cancelable: true }), { pointerId }))
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.restoreAllMocks()
})

describe('sidebar width', () => {
  it.each([
    [0, SIDEBAR_MIN_WIDTH], [200, 200], [220.6, 221], [900, SIDEBAR_MAX_WIDTH],
    [NaN, SIDEBAR_DEFAULT_WIDTH], [Infinity, SIDEBAR_DEFAULT_WIDTH],
  ])('clamps %s to %s', (input, expected) => {
    expect(clampSidebarWidth(input)).toBe(expected)
  })

  it.each([
    [null, SIDEBAR_DEFAULT_WIDTH], ['', SIDEBAR_DEFAULT_WIDTH], ['broken', SIDEBAR_DEFAULT_WIDTH],
    ['270', 270], ['2', SIDEBAR_MIN_WIDTH], ['9999', SIDEBAR_MAX_WIDTH],
  ])('safely restores saved width %s', (stored, expected) => {
    if (stored !== null) localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, stored)
    expect(mountResize().resize.sidebarWidth.value).toBe(expected)
  })

  it('drags within both limits, persists on release, and stops moving afterwards', () => {
    const { resize, handle } = mountResize()
    pointer(handle, 'pointerdown', 218)
    expect(resize.sidebarResizing.value).toBe(true)
    pointer(window, 'pointermove', 280)
    expect(resize.sidebarWidth.value).toBe(280)
    pointer(window, 'pointermove', 900)
    expect(resize.sidebarWidth.value).toBe(SIDEBAR_MAX_WIDTH)
    pointer(window, 'pointermove', 10)
    expect(resize.sidebarWidth.value).toBe(SIDEBAR_MIN_WIDTH)
    pointer(window, 'pointerup', 10)
    expect(resize.sidebarResizing.value).toBe(false)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(SIDEBAR_MIN_WIDTH))
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1)
    pointer(window, 'pointermove', 290)
    expect(resize.sidebarWidth.value).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('ignores right clicks and other pointers during a drag', () => {
    const { resize, handle } = mountResize()
    pointer(handle, 'pointerdown', 218, 1, 2)
    expect(resize.sidebarResizing.value).toBe(false)
    pointer(handle, 'pointerdown', 218)
    pointer(window, 'pointermove', 300, 2)
    pointer(window, 'pointerup', 300, 2)
    expect(resize.sidebarWidth.value).toBe(218)
    expect(resize.sidebarResizing.value).toBe(true)
  })

  it.each(['pointercancel', 'blur'])('cleans up when dragging ends with %s', type => {
    const { resize, handle } = mountResize()
    pointer(handle, 'pointerdown', 218)
    pointer(window, type, 218)
    expect(resize.sidebarResizing.value).toBe(false)
    pointer(window, 'pointermove', 300)
    expect(resize.sidebarWidth.value).toBe(218)
  })

  it('stops when hidden, keeps the chosen width, and restores it on remount', async () => {
    const { resize, handle, enabled } = mountResize()
    pointer(handle, 'pointerdown', 218)
    pointer(window, 'pointermove', 270)
    enabled.value = false
    await nextTick()
    expect(resize.sidebarResizing.value).toBe(false)
    pointer(handle, 'pointerdown', 270)
    pointer(window, 'pointermove', 310)
    expect(resize.sidebarWidth.value).toBe(270)
    expect(mountResize().resize.sidebarWidth.value).toBe(270)
  })

  it('supports keyboard resizing and min/max shortcuts', () => {
    const { resize } = mountResize()
    for (const [key, expected] of [['ArrowRight', 226], ['ArrowLeft', 218], ['End', 320], ['ArrowRight', 320], ['Home', 176], ['ArrowLeft', 176]] as const) {
      const event = new KeyboardEvent('keydown', { key, cancelable: true })
      resize.resizeSidebarWithKeyboard(event)
      expect(event.defaultPrevented).toBe(true)
      expect(resize.sidebarWidth.value).toBe(expected)
      expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(expected))
    }
  })

  it('removes active drag listeners on unmount', () => {
    const { resize, handle, unmount } = mountResize()
    pointer(handle, 'pointerdown', 218)
    unmount()
    cleanups.pop()
    pointer(window, 'pointermove', 300)
    expect(resize.sidebarResizing.value).toBe(false)
    expect(resize.sidebarWidth.value).toBe(218)
  })

  it('still resizes when local storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable') })
    const { resize } = mountResize()
    resize.resizeSidebarWithKeyboard(new KeyboardEvent('keydown', { key: 'End' }))
    expect(resize.sidebarWidth.value).toBe(320)
  })
})
