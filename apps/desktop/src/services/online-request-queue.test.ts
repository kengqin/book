import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnlineRequestQueue } from './online-request-queue'

function deferred<T = string>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { vi.useRealTimers() })

describe('online request scheduling', () => {
  it('returns a page immediately while spacing starts on the same hostname', async () => {
    const queue = new OnlineRequestQueue(), first = deferred()
    const starts: number[] = []
    const a = queue.run('https://book.example/1', () => { starts.push(Date.now()); return first.promise })
    const b = queue.run('https://book.example:8443/2', async () => { starts.push(Date.now()); return 'two' })
    await vi.advanceTimersByTimeAsync(200)
    first.resolve('one')
    await vi.advanceTimersByTimeAsync(0)
    expect(await a).toBe('one')
    expect(starts).toEqual([0])
    await vi.advanceTimersByTimeAsync(500)
    expect(await b).toBe('two')
    expect(starts).toEqual([0, 700])
  })

  it('lets a slow site finish without delaying another site or adding a post-response wait', async () => {
    const queue = new OnlineRequestQueue(), first = deferred()
    const starts: number[] = []
    const a = queue.run('https://slow.example/1', () => first.promise)
    const b = queue.run('https://slow.example/2', async () => { starts.push(Date.now()); return 'two' })
    const other = queue.run('https://fast.example/1', async () => 'other')
    await vi.advanceTimersByTimeAsync(1200)
    expect(await other).toBe('other')
    expect(starts).toEqual([])
    first.resolve('one')
    await vi.advanceTimersByTimeAsync(0)
    expect(await a).toBe('one'); expect(await b).toBe('two')
    expect(starts).toEqual([1200])
  })

  it('bounds background traffic and reserves capacity for the reader', async () => {
    const queue = new OnlineRequestQueue(), work = Array.from({ length: 5 }, () => deferred())
    const starts: number[] = []
    const downloads = work.map((job, i) => queue.run(`https://site-${i}.example/1`, () => { starts.push(i); return job.promise }, { priority: 'background' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(starts).toEqual([0, 1, 2])
    expect(await queue.run('https://reader.example/1', async () => 'reading')).toBe('reading')
    expect(starts).toEqual([0, 1, 2])
    for (const job of work) job.resolve('done')
    await vi.runAllTimersAsync(); await Promise.all(downloads)
    expect(starts).toEqual([0, 1, 2, 3, 4])
  })

  it('prioritizes reading and promotes an existing queued download without fetching twice', async () => {
    const queue = new OnlineRequestQueue(), active = deferred(), group = {}, order: string[] = []
    const a = queue.run('https://book.example/active', () => active.promise)
    const b = queue.run('https://book.example/background', async () => { order.push('background'); return '' }, { priority: 'background' })
    const c = queue.run('https://book.example/promoted', async () => { order.push('promoted'); return '' }, { priority: 'background', group })
    queue.promote(group)
    active.resolve('done')
    await vi.runAllTimersAsync(); await Promise.all([a, b, c])
    expect(order).toEqual(['promoted', 'background'])
  })

  it('cancels queued work promptly without letting other work in the group start', async () => {
    const queue = new OnlineRequestQueue(), group = {}, work = vi.fn(async () => '')
    const controller = new AbortController()
    const jobs = Array.from({ length: 5 }, (_, i) => queue.run(`https://site-${i}.example/1`, work, { group, signal: controller.signal, priority: 'background' }).catch(cause => cause))
    // The first three have acquired slots but have not called work until the next microtask.
    queue.cancelQueued(group)
    await vi.runAllTimersAsync()
    const results = await Promise.all(jobs)
    expect(work).toHaveBeenCalledTimes(3)
    expect(results.slice(3).map(result => result.name)).toEqual(['AbortError', 'AbortError'])
  })

  it('does not free the native slot or host when an in-flight caller aborts', async () => {
    const queue = new OnlineRequestQueue(), native = deferred(), controller = new AbortController(), next = vi.fn(async () => 'next')
    const a = queue.run('https://book.example/1', () => native.promise, { signal: controller.signal }).catch(cause => cause)
    const b = queue.run('https://book.example/2', next)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect((await a).name).toBe('AbortError')
    await vi.advanceTimersByTimeAsync(2000)
    expect(next).not.toHaveBeenCalled()
    native.resolve('late')
    await vi.runAllTimersAsync()
    expect(await b).toBe('next')
  })

  it('backs off a rate-limited host without blocking another host', async () => {
    const queue = new OnlineRequestQueue(), starts: number[] = []
    const a = queue.run('https://limited.example/1', async () => { throw new Error('网站返回 HTTP 429') }).catch(cause => cause)
    const b = queue.run('https://limited.example/2', async () => { starts.push(Date.now()); return '' })
    const c = queue.run('https://other.example/1', async () => { starts.push(Date.now()); return '' })
    await vi.runAllTimersAsync(); await Promise.all([a, b, c])
    expect(starts).toEqual([0, 3000])
  })

  it('finishes two three-page sites in 1.6 seconds with 200 ms responses', async () => {
    const queue = new OnlineRequestQueue()
    const download = async (host: string) => {
      for (let i = 0; i < 3; i++) await queue.run(`https://${host}/${i}`, () => new Promise(resolve => setTimeout(resolve, 200)), { priority: 'background' })
    }
    const jobs = Promise.all([download('a.example'), download('b.example')])
    await vi.runAllTimersAsync(); await jobs
    expect(Date.now()).toBe(1600)
    // The previous global queue took 6 * (200 ms response + 700 ms extra wait) = 5400 ms.
  })
})
