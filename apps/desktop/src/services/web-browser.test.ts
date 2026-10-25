// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), event: undefined as undefined | ((e: { payload: unknown }) => void) }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mock.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mock.listen }))
import { browserAddress, browserMode, changeWebBrowserMode, initializeWebBrowser, openWebPage, webPageUrl } from './web-browser'

describe('internal web browser', () => {
  beforeEach(() => { localStorage.clear(); mock.invoke.mockReset(); mock.listen.mockReset() })
  it('defaults to a separate window and remembers an explicit side preference', async () => {
    expect(browserMode()).toBe('window')
    mock.invoke.mockResolvedValue(undefined)
    await changeWebBrowserMode('side')
    expect(mock.invoke).toHaveBeenCalledWith('set_web_browser_mode', { mode: 'side' })
    expect(browserMode()).toBe('side')
  })
  it('preserves query strings and in-page anchors and rejects executable addresses', () => {
    expect(webPageUrl('https://example.com/a?q=小说#第二节')).toBe(new URL('https://example.com/a?q=小说#第二节').href)
    for (const url of ['file:///C:/book', 'javascript:alert(1)', 'data:text/html,test', 'https://u:p@example.com']) expect(webPageUrl(url)).toBeUndefined()
    expect(browserAddress('example.com/book#toc')).toBe('https://example.com/book#toc')
    expect(browserAddress('小说 搜索')).toBe('https://cn.bing.com/search?q=' + encodeURIComponent('小说 搜索'))
    expect(() => browserAddress('javascript:alert(1)')).toThrow('HTTP')
  })
  it('does not overwrite the saved preference with the unopened native default', async () => {
    localStorage.setItem('novel-library-web-browser-mode', 'side')
    mock.listen.mockImplementation(async (event, handler) => { if (event === 'web-browser-state') mock.event = handler; return () => {} })
    mock.invoke.mockResolvedValue({ open: false, mode: 'window', url: '', title: '', loading: false, canGoBack: false, canGoForward: false })
    await initializeWebBrowser()
    expect(browserMode()).toBe('side')
    mock.event?.({ payload: { open: false, mode: 'window', url: '', title: '', loading: false, sideSuspended: false, canGoBack: false, canGoForward: false } })
    expect(browserMode()).toBe('side')
    await openWebPage('https://example.com/#toc')
    expect(mock.invoke).toHaveBeenLastCalledWith('open_web_browser', { url: 'https://example.com/#toc', mode: 'side', newTab: true })
  })
})
