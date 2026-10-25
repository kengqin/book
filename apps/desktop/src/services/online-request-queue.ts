export type RequestPriority = 'foreground' | 'background'

interface RequestOptions {
  priority?: RequestPriority
  signal?: AbortSignal
  group?: object
}
interface PendingRequest {
  host: string
  priority: RequestPriority
  group?: object
  start: () => void
  cancel: () => void
}
interface HostState { active: boolean; nextStart: number }

const cancelled = () => new DOMException('请求已取消', 'AbortError')

/** One request per host, with bounded cross-site traffic and a slot reserved for reading. */
export class OnlineRequestQueue {
  private readonly hosts = new Map<string, HostState>()
  private readonly pending: PendingRequest[] = []
  private active = 0
  private backgroundActive = 0
  private timer?: ReturnType<typeof setTimeout>

  constructor(private readonly gap = 700, private readonly limit = 4) {}

  run<T>(url: string, work: () => Promise<T>, options: RequestOptions = {}): Promise<T> {
    const host = new URL(url).hostname.toLowerCase()
    if (options.signal?.aborted) return Promise.reject(cancelled())
    return new Promise<T>((resolve, reject) => {
      let started = false
      const finish = () => options.signal?.removeEventListener('abort', abort)
      const abort = () => {
        reject(cancelled())
        // Native HTTP may still be running. Keep its host/slot occupied until it settles.
        if (!started) {
          const index = this.pending.indexOf(entry)
          if (index !== -1) this.pending.splice(index, 1)
          finish()
          this.drain()
        }
      }
      const entry: PendingRequest = {
        host, priority: options.priority ?? 'foreground', group: options.group, cancel: abort,
        start: () => {
          started = true
          const state = this.hosts.get(host)!
          const background = entry.priority === 'background'
          state.active = true
          state.nextStart = Date.now() + this.gap
          this.active++
          if (background) this.backgroundActive++
          void Promise.resolve().then(work).then(resolve, cause => {
            // Rate-limited sites cool down independently; other sites can keep downloading.
            if (/HTTP (429|503)/u.test(String(cause))) state.nextStart = Math.max(state.nextStart, Date.now() + 3000)
            reject(cause)
          }).finally(() => {
            finish()
            state.active = false
            this.active--
            if (background) this.backgroundActive--
            this.drain()
          })
        }
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      this.pending.push(entry)
      this.drain()
    })
  }

  promote(group: object) {
    for (const entry of this.pending) if (entry.group === group) entry.priority = 'foreground'
    this.drain()
  }

  cancelQueued(group: object) {
    const entries = this.pending.filter(entry => entry.group === group)
    for (const entry of entries) this.pending.splice(this.pending.indexOf(entry), 1)
    for (const entry of entries) entry.cancel()
  }

  private drain() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const now = Date.now()
    for (const [host, state] of this.hosts) {
      if (!state.active && state.nextStart <= now && !this.pending.some(entry => entry.host === host)) this.hosts.delete(host)
    }
    let wake = Infinity
    // Stable priority keeps FIFO order within each priority, including across books.
    for (const entry of [...this.pending].sort((a, b) => Number(a.priority === 'background') - Number(b.priority === 'background'))) {
      if (this.active >= this.limit) break
      if (entry.priority === 'background' && this.backgroundActive >= this.limit - 1) continue
      let state = this.hosts.get(entry.host)
      if (!state) { state = { active: false, nextStart: 0 }; this.hosts.set(entry.host, state) }
      if (state.active) continue
      if (state.nextStart > now) { wake = Math.min(wake, state.nextStart - now); continue }
      this.pending.splice(this.pending.indexOf(entry), 1)
      entry.start()
    }
    if (Number.isFinite(wake)) this.timer = setTimeout(() => this.drain(), wake)
  }
}
