// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ discover: vi.fn(), add: vi.fn() }))
vi.mock('./online-parser', () => ({ discoverCatalog: mocks.discover }))
vi.mock('./online-library', () => ({ addOnlineBook: mocks.add, fetchOnlinePage: vi.fn(), onlineBooks: { value: [] }, refreshOnlineBooks: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

beforeEach(() => { vi.resetModules(); mocks.discover.mockReset(); mocks.add.mockReset().mockResolvedValue('book-1') })

it('retains edited metadata through later directory batches and imports it', async () => {
  const first = { title: '自动书名', author: '自动作者', catalogUrl: 'https://example.com/book', chapters: [{ title: '第1章', url: 'https://example.com/1' }], warnings: [], complete: false }
  let finish!: () => void
  mocks.discover.mockImplementation(async (_url, _fetch, _progress, publish) => {
    await publish(first)
    await new Promise<void>(resolve => { finish = resolve })
    const full = { ...first, chapters: [...first.chapters, { title: '第2章', url: 'https://example.com/2' }] }
    await publish(full)
    return full
  })
  const { beginOnlineDiscovery } = await import('./online-discovery')
  const job = beginOnlineDiscovery(first.catalogUrl)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  job.setMetadata(' 修正书名 ', ' 修正作者 ')
  finish()
  await job.done
  expect(job.state.catalog).toMatchObject({ title: '修正书名', author: '修正作者', complete: true })
  expect(job.state.catalog?.chapters).toHaveLength(2)
  await job.adopt()
  expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ title: '修正书名', author: '修正作者', complete: true }))
})
