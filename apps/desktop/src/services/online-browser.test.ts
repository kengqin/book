// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isVerificationPage } from './online-verification'

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }))
const normal = '<h1>第一章 安全检查</h1><div id="content">' + '山风穿过长街，人们继续前行。'.repeat(20) + '</div>'
beforeEach(() => { vi.resetModules(); native.invoke.mockReset(); native.listen.mockReset().mockResolvedValue(() => {}) })

describe('website browser verification', () => {
  it('recognizes challenge pages without treating a novel about verification as a challenge', () => {
    expect(isVerificationPage('<title>Just a moment...</title><form id="challenge-form"></form>')).toBe(true)
    expect(isVerificationPage('<title>请稍候…</title><h1>example.com</h1><p>验证成功。正在等待响应</p><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>')).toBe(true)
    expect(isVerificationPage('<title>网站访问</title><iframe src="https://challenges.cloudflare.com/widget"></iframe>')).toBe(true)
    expect(isVerificationPage(normal + '<iframe src="https://hcaptcha.com/footer"></iframe>')).toBe(false)
    expect(isVerificationPage('<h1>第一章</h1><div id="content">' + '验证自己的想法。'.repeat(20) + '</div>')).toBe(false)
  })
  it('opens a browser after HTTP 403 and uses that browser session for later chapters', async () => {
    native.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === 'fetch_online_page') throw '网站返回 HTTP 403'
      if (command === 'fetch_online_browser') return { url: args.url, html: normal }
      throw new Error(command)
    })
    const service = await import('./online-browser')
    expect((await service.fetchOnlinePageWithVerification('https://example.com/1')).html).toBe(normal)
    await service.fetchOnlinePageWithVerification('https://example.com/2')
    expect(native.invoke.mock.calls.filter(([cmd]) => cmd === 'fetch_online_page')).toHaveLength(1)
    expect(native.invoke.mock.calls.filter(([cmd]) => cmd === 'fetch_online_browser')).toHaveLength(2)
    expect(native.listen).toHaveBeenCalledOnce()
  })
  it('shows the challenge returned with HTTP 200 and retains a redirected session', async () => {
    native.invoke.mockImplementation(async (command: string, args: any) => command === 'fetch_online_page'
      ? { url: 'https://canonical.example/1', html: '<title>人机验证</title>' }
      : { url: args.url, html: normal })
    const service = await import('./online-browser')
    await service.fetchOnlinePageWithVerification('https://source.example/1')
    expect(native.invoke).toHaveBeenLastCalledWith('fetch_online_browser', expect.objectContaining({ url: 'https://canonical.example/1', interactive: true }))
    await service.fetchOnlinePageWithVerification('https://canonical.example/2')
    expect(native.invoke.mock.calls.filter(([cmd]) => cmd === 'fetch_online_page')).toHaveLength(1)
  })
  it('leaves search-engine verification to its existing dedicated browser', async () => {
    native.invoke.mockRejectedValue('网站返回 HTTP 403')
    const service = await import('./online-browser')
    await expect(service.fetchOnlinePageWithVerification('https://www.baidu.com/s?q=test', undefined, false)).rejects.toBe('网站返回 HTTP 403')
    expect(native.invoke).toHaveBeenCalledOnce()
    expect(native.listen).not.toHaveBeenCalled()
  })
  it('renders a script-only HTTP 200 page and waits for dynamic chapter text', async () => {
    native.invoke.mockImplementation(async (command: string, args: any) => command === 'fetch_online_page'
      ? { url: args.url, html: '<body><script src="/boot.js"></script></body>' }
      : { url: args.url, html: normal })
    const service = await import('./online-browser')
    expect((await service.fetchOnlinePageWithVerification('https://example.com/book')).html).toBe(normal)
    expect(native.invoke).toHaveBeenLastCalledWith('fetch_online_browser', expect.objectContaining({ interactive: false }))
    native.invoke.mockImplementation(async (command: string, args: any) => command === 'fetch_online_page'
      ? { url: args.url, html: '<h3>第一章</h3><div id="BookText"><p>正在为您转码……</p></div><script src="/chapter.js"></script>' }
      : { url: args.url, html: normal })
    expect((await service.fetchOnlinePageWithVerification('https://third.example/1')).html).toBe(normal)
    expect(native.invoke).toHaveBeenLastCalledWith('fetch_online_browser', expect.objectContaining({ interactive: false }))
  })
  it('keeps ordinary static chapters on direct HTTP even when scripts mention loading', async () => {
    native.invoke.mockImplementation(async (_command: string, args: any) => ({ url: args.url, html: normal + '<script>const hint="正在加载"</script>' }))
    const service = await import('./online-browser')
    await service.fetchOnlinePageWithVerification('https://example.com/1')
    expect(native.invoke).toHaveBeenCalledOnce()
  })
  it('renders a hydrated detail catalogue rather than importing its static preview', async () => {
    native.invoke.mockImplementation(async (command: string, args: any) => command === 'fetch_online_page'
      ? { url: args.url, html: '<div id="__nuxt"><section>' + '作品介绍。'.repeat(20) + '</section></div><script src="/app.js"></script>' }
      : { url: args.url, html: normal })
    const service = await import('./online-browser')
    await service.fetchOnlinePageWithVerification('https://example.com/book?tab=catalogue')
    expect(native.invoke).toHaveBeenLastCalledWith('fetch_online_browser', expect.objectContaining({ interactive: false }))
  })
  it('cancels the native window when the caller aborts and discards its late result', async () => {
    let release!: () => void
    native.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === 'fetch_online_page') throw '网站返回 HTTP 403'
      if (command === 'fetch_online_browser') return new Promise(resolve => { release = () => resolve({ url: args.url, html: normal }) })
    })
    const service = await import('./online-browser'), controller = new AbortController()
    const work = service.fetchOnlinePageWithVerification('https://example.com/1', controller.signal).catch(cause => cause)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    controller.abort(); release()
    expect((await work).name).toBe('AbortError')
    expect(native.invoke).toHaveBeenCalledWith('cancel_online_browser', expect.objectContaining({ requestId: expect.any(String) }))
    expect(service.onlineVerifications.value).toEqual([])
  })
  it('clears a waiting notice after the user closes the verification window', async () => {
    let listener!: (event: any) => void
    native.listen.mockImplementation(async (_event, callback) => { listener = callback; return () => {} })
    native.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === 'fetch_online_page') throw '网站返回 HTTP 403'
      listener({ payload: { requestId: args.requestId, url: args.url, waiting: true } })
      throw '网页验证已取消'
    })
    const service = await import('./online-browser')
    await expect(service.fetchOnlinePageWithVerification('https://example.com/1')).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.onlineVerifications.value).toEqual([])
  })
})
