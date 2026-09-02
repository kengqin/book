import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'

const binaryName = process.platform === 'win32' ? 'novel-library-runtime.exe' : 'novel-library-runtime'
const runtimePath = path.resolve('apps', 'local-runtime', 'target', 'release', binaryName)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-library-runtime-e2e-'))
const discoveryPath = path.join(root, 'local-runtime.json')
let child

async function waitFor(predicate, label, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await predicate().catch(() => undefined)
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${label} timeout`)
}

async function startRuntime() {
  child = spawn(runtimePath, ['serve', '--data-dir', root, '--port', '0'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const discovery = await waitFor(async () => {
    const payload = JSON.parse(await fs.readFile(discoveryPath, 'utf8'))
    const response = await fetch(`http://127.0.0.1:${payload.port}/v1/health`, { signal: AbortSignal.timeout(500) })
    return response.ok ? payload : undefined
  }, `runtime start (${stderr})`)
  return discovery
}

async function stopRuntime(discovery) {
  await fetch(`http://127.0.0.1:${discovery.port}/v2/runtime/restart`, {
    method: 'POST',
    headers: { authorization: `Bearer ${discovery.token}` }
  })
  await waitFor(async () => !await fs.stat(discoveryPath).then(() => true, () => false), 'runtime stop')
  if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve))
  child = undefined
}

function requester(discovery) {
  return async (route, options = {}, expectedStatus) => {
    const response = await fetch(`http://127.0.0.1:${discovery.port}${route}`, {
      ...options,
      headers: {
        authorization: `Bearer ${discovery.token}`,
        'content-type': 'application/json',
        ...(options.headers || {})
      }
    })
    const payload = await response.json()
    if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, JSON.stringify(payload))
    else assert.equal(response.ok, true, `${route}: ${JSON.stringify(payload)}`)
    return payload
  }
}

async function waitForJob(request, id) {
  for (let attempt = 0; attempt < 1500; attempt += 1) {
    const job = await request(`/v2/import-jobs/${encodeURIComponent(id)}`)
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return job
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('import job timeout')
}

async function runRuntimeCommand(args) {
  const process = spawn(runtimePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  process.stdout.on('data', chunk => { stdout += chunk })
  process.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise(resolve => process.once('close', resolve))
  return { code, stdout, stderr }
}

async function writeStructuredEpub(target) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>')
  zip.file('OPS/content.opf', '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>独立 EPUB 测试</dc:title><dc:creator>测试作者</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="intro" href="intro.xhtml" media-type="application/xhtml+xml"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="cover"/><itemref idref="intro"/><itemref idref="chapter"/></spine></package>')
  zip.file('OPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="cover.xhtml">封面</a></li><li><a href="intro.xhtml">内容简介</a></li><li><a href="chapter.xhtml">第一章 开始</a></li></ol></nav></body></html>')
  zip.file('OPS/cover.xhtml', '<html><body><p>Cover</p></body></html>')
  zip.file('OPS/intro.xhtml', '<html><body><h1>内容简介</h1><p>结构化简介</p></body></html>')
  zip.file('OPS/chapter.xhtml', '<html><body><h1>第一章 开始</h1><p>真正正文</p></body></html>')
  await fs.writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }))
}

try {
  await fs.access(runtimePath)
  const source = path.join(root, 'book.txt')
  await fs.writeFile(source, '《独立运行测试》\n作者：测试\n第一章 开始\n正文一\n第二章 继续\n正文二', 'utf8')
  let discovery = await startRuntime()
  let request = requester(discovery)

  const manifest = await request('/v2/manifest')
  assert.equal(manifest.providerType, 'local')
  assert.equal(manifest.protocolVersion, 2)
  assert.ok(manifest.storageId)
  assert.ok(manifest.capabilities.includes('runtime.diagnostics'))
  assert.ok(manifest.capabilities.includes('epub.structure.v2'))
  const storageId = manifest.storageId
  const status = await request('/v2/runtime/status')
  assert.equal(path.resolve(status.dataDirectory), path.resolve(root))
  assert.equal(status.storageId, storageId)

  const startedAt = Date.now()
  const queued = await request('/v2/import-jobs', {
    method: 'POST',
    body: JSON.stringify({ path: source, idempotencyKey: 'runtime-e2e-initial-import' })
  }, 202)
  assert.equal(queued.state, 'queued')
  assert.ok(Date.now() - startedAt < 2000, 'job creation must not wait for parsing')
  const completed = await waitForJob(request, queued.id)
  assert.equal(completed.state, 'completed')
  assert.ok(completed.resultBookId)
  const repeatedImport = await request('/v2/import-jobs', {
    method: 'POST',
    body: JSON.stringify({ path: source, idempotencyKey: 'runtime-e2e-initial-import' })
  }, 202)
  assert.equal(repeatedImport.id, queued.id, 'idempotencyKey must return the original import job')

  const epubSource = path.join(root, 'structured.epub')
  await writeStructuredEpub(epubSource)
  const epubQueued = await request('/v2/import-jobs', {
    method: 'POST',
    body: JSON.stringify({ path: epubSource })
  }, 202)
  const epubCompleted = await waitForJob(request, epubQueued.id)
  assert.equal(epubCompleted.state, 'completed')
  const epubChapters = await request(`/v2/books/${encodeURIComponent(epubCompleted.resultBookId)}/chapters`)
  assert.deepEqual(epubChapters.map(chapter => chapter.kind), ['frontmatter', 'frontmatter', 'chapter'])
  const epubBody = await request(`/v2/books/${encodeURIComponent(epubCompleted.resultBookId)}/chapters/3`)
  assert.equal(epubBody.title, '开始')
  assert.equal(epubBody.originalLabel, '一')
  assert.equal(epubBody.contentText, '真正正文')
  const epubBook = await request(`/v2/books/${encodeURIComponent(epubCompleted.resultBookId)}`)
  assert.equal(epubBook.description, '结构化简介')
  await request(`/v2/books/${encodeURIComponent(epubCompleted.resultBookId)}`, { method: 'DELETE' })

  if (process.env.EPUB_TEST_FILE) {
    const realQueued = await request('/v2/import-jobs', {
      method: 'POST',
      body: JSON.stringify({ path: path.resolve(process.env.EPUB_TEST_FILE) })
    }, 202)
    const realCompleted = await waitForJob(request, realQueued.id)
    assert.equal(realCompleted.state, 'completed')
    const realBook = await request(`/v2/books/${encodeURIComponent(realCompleted.resultBookId)}`)
    const realChapters = await request(`/v2/books/${encodeURIComponent(realCompleted.resultBookId)}/chapters`)
    if (realBook.title === '斗破苍穹') {
      assert.equal(realChapters.length, 1649)
      assert.equal(realChapters.filter(chapter => chapter.kind === 'frontmatter').length, 3)
      assert.equal(realChapters.filter(chapter => chapter.kind === 'chapter').length, 1646)
      const firstBody = realChapters.find(chapter => chapter.kind === 'chapter')
      assert.equal(firstBody.number, 4)
      assert.equal(firstBody.title, '陨落的天才')
      const firstBodyContent = await request(`/v2/books/${encodeURIComponent(realCompleted.resultBookId)}/chapters/${firstBody.number}`)
      assert.match(firstBodyContent.contentText, /^“斗之力，三段！”/)
      console.log('Real EPUB Runtime parity passed: 3 frontmatter + 1646 body chapters')
    }
    await request(`/v2/books/${encodeURIComponent(realCompleted.resultBookId)}`, { method: 'DELETE' })
  }

  const unsupported = path.join(root, 'unsupported.pdf')
  await fs.writeFile(unsupported, 'not a supported book')
  const failedQueued = await request('/v2/import-jobs', {
    method: 'POST',
    body: JSON.stringify({ path: unsupported })
  }, 202)
  assert.equal(failedQueued.state, 'queued')
  const failed = await waitForJob(request, failedQueued.id)
  assert.equal(failed.state, 'failed')
  assert.match(failed.message, /[只仅]支持 TXT 和 EPUB/)

  const booksBefore = await request('/v2/books')
  assert.equal(booksBefore.length, 1)
  const progress = await request('/v2/progress', {
    method: 'POST',
    body: JSON.stringify({
      bookId: booksBefore[0].id,
      chapterNumber: 2,
      chapterProgress: 25,
      baseRevision: booksBefore[0].revision,
      clientId: 'runtime-e2e',
      sequence: 1
    })
  })
  assert.equal(progress.chapterNumber, 2)
  await request('/v2/progress', {
    method: 'POST',
    body: JSON.stringify({
      bookId: booksBefore[0].id,
      chapterNumber: 1,
      chapterProgress: 0,
      baseRevision: booksBefore[0].revision,
      clientId: 'another-client',
      sequence: 1
    })
  }, 409)

  const duplicateQueued = await request('/v2/import-jobs', {
    method: 'POST',
    body: JSON.stringify({ path: source })
  }, 202)
  assert.equal((await waitForJob(request, duplicateQueued.id)).resultBookId, booksBefore[0].id)
  assert.equal((await request('/v2/books')).length, 1, 'same source hash must not create a duplicate book')

  const reparseQueued = await request(`/v2/books/${encodeURIComponent(booksBefore[0].id)}/reparse`, {
    method: 'POST',
    body: '{}'
  }, 202)
  assert.equal((await waitForJob(request, reparseQueued.id)).state, 'completed')

  const diagnostics = await request('/v2/runtime/diagnostics')
  assert.equal(diagnostics.ok, true)
  assert.equal(diagnostics.storageIdSuffix, storageId.slice(-6))
  assert.equal('databasePath' in diagnostics, false)
  const databaseCheck = await request('/v2/runtime/check-database', { method: 'POST', body: '{}' })
  assert.equal(databaseCheck.ok, true)

  const transferPath = path.join(root, 'backups', 'library.json')
  await request('/v2/transfers/export', {
    method: 'POST',
    body: JSON.stringify({ path: transferPath })
  })
  const transfer = JSON.parse(await fs.readFile(transferPath, 'utf8'))
  assert.equal(transfer.format, 'novel-library-backup')
  assert.match(transfer.checksumSha256, /^[a-f0-9]{64}$/)
  const tamperedTransfer = path.join(root, 'backups', 'tampered.json')
  await fs.writeFile(tamperedTransfer, JSON.stringify({
    ...transfer,
    books: transfer.books.map((book, index) => index === 0 ? { ...book, title: `${book.title}-篡改` } : book)
  }))
  await request('/v2/transfers/import', {
    method: 'POST',
    body: JSON.stringify({ path: tamperedTransfer, strategy: 'merge' })
  }, 400)

  await request(`/v2/books/${encodeURIComponent(booksBefore[0].id)}`, { method: 'DELETE' })
  assert.equal((await request('/v2/books')).length, 0)
  await request('/v2/transfers/import', {
    method: 'POST',
    body: JSON.stringify({ path: transferPath, strategy: 'merge' })
  })
  assert.equal((await request('/v2/books')).length, 1, 'backup restore must recover a deleted book')
  const replaced = await request('/v2/transfers/import', {
    method: 'POST',
    body: JSON.stringify({ path: transferPath, strategy: 'replace' })
  })
  assert.ok(replaced.automaticBackupPath)
  await fs.access(replaced.automaticBackupPath)
  assert.equal((await request('/v2/books')).length, 1)

  const invalidTransfer = path.join(root, 'invalid-transfer.json')
  await fs.writeFile(invalidTransfer, JSON.stringify({
    format: 'novel-library-transfer',
    version: 1,
    books: [],
    chapters: [{
      id: 'chapter-1', bookId: 'missing', number: 1, originalLabel: '第一章',
      title: '无效章节', volume: '', kind: 'chapter', content: 'x', contentText: 'x',
      wordCount: 1, contentFormat: 'text'
    }]
  }))
  await request('/v2/transfers/import', {
    method: 'POST',
    body: JSON.stringify({ path: invalidTransfer, strategy: 'replace' })
  }, 400)
  assert.equal((await request('/v2/books')).length, 1, 'failed replace must preserve the library')

  await stopRuntime(discovery)
  await fs.writeFile(path.join(root, 'migration.lock'), 'test')
  const blocked = spawn(runtimePath, ['serve', '--data-dir', root, '--port', '0'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  const blockedResult = await new Promise(resolve => {
    let stderr = ''
    blocked.stderr.on('data', chunk => { stderr += chunk })
    blocked.once('close', code => resolve({ code, stderr }))
  })
  assert.equal(blockedResult.code, 1)
  assert.match(blockedResult.stderr, /正在迁移/)
  await fs.rm(path.join(root, 'migration.lock'), { force: true })

  discovery = await startRuntime()
  request = requester(discovery)
  assert.equal((await request('/v2/books')).length, 1, 'library must survive restart')
  assert.equal((await request('/v2/manifest')).storageId, storageId, 'storageId must survive restart')
  child.kill()
  if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve))
  child = undefined
  assert.equal(await fs.stat(discoveryPath).then(() => true, () => false), true, 'crash must leave stale discovery for recovery test')
  discovery = await startRuntime()
  request = requester(discovery)
  assert.equal((await request('/v2/books')).length, 1, 'library must recover after an ungraceful Runtime exit')
  assert.equal((await request('/v2/manifest')).storageId, storageId, 'storageId must survive crash recovery')
  await stopRuntime(discovery)
  const doctor = await runRuntimeCommand(['doctor', '--data-dir', root])
  assert.equal(doctor.code, 0, doctor.stderr)
  assert.equal(JSON.parse(doctor.stdout).ok, true)
  console.log('Local Runtime end-to-end test passed')
} finally {
  if (child && child.exitCode === null) child.kill()
  await fs.rm(root, { recursive: true, force: true })
}
