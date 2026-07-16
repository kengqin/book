import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseEpubBuffer } from './parse-epub'

const pixel = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2,
  0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3,
  3, 2, 0, 238, 254, 95, 209, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
])

async function epubFixture() {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`)
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="book-id">fixture-book</dc:identifier>
        <dc:title>EPUB 测试书</dc:title>
        <dc:creator>测试作者</dc:creator>
        <dc:description>用于验证本地 EPUB 解析。</dc:description>
        <dc:language>zh-CN</dc:language>
        <meta property="dcterms:modified">2026-07-16T00:00:00Z</meta>
      </metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="chapter-1" href="Text/chapter-1.xhtml" media-type="application/xhtml+xml"/>
        <item id="chapter-2" href="Text/chapter-2.xhtml" media-type="application/xhtml+xml"/>
        <item id="cover" href="Images/cover.png" media-type="image/png" properties="cover-image"/>
      </manifest>
      <spine><itemref idref="chapter-1"/><itemref idref="chapter-2"/></spine>
    </package>`)
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
      <nav epub:type="toc"><ol><li><a href="Text/chapter-1.xhtml">第一卷 起程</a><ol>
        <li><a href="Text/chapter-1.xhtml">第一章 初见</a></li>
        <li><a href="Text/chapter-2.xhtml">第二章 风雨</a></li>
      </ol></li></ol></nav>
    </body></html>`)
  zip.file('OEBPS/Text/chapter-1.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><head><title>初见</title></head><body>
      <h1>第一章 初见</h1><p onclick="alert(1)">第一章正文。</p>
      <img src="../Images/cover.png" alt="插图"/><script>alert('x')</script>
    </body></html>`)
  zip.file('OEBPS/Text/chapter-2.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><head><title>风雨</title></head><body>
      <h1>第二章 风雨</h1><blockquote>第二章正文。</blockquote>
    </body></html>`)
  zip.file('OEBPS/Images/cover.png', pixel)
  return zip.generateAsync({ type: 'uint8array' })
}

describe('EPUB parser', () => {
  it('parses metadata, spine order, nested navigation and embedded images', async () => {
    const bytes = await epubFixture()
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const result = parseEpubBuffer(buffer, 'fixture.epub')

    expect(result.metadata).toMatchObject({
      title: 'EPUB 测试书',
      author: '测试作者',
      sourceFormat: 'epub',
      sourceName: 'fixture.epub'
    })
    expect(result.metadata.coverDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(result.chapters.map(chapter => chapter.title)).toEqual(['初见', '风雨'])
    expect(result.chapters.every(chapter => chapter.volume === '第一卷 起程')).toBe(true)
    expect(result.chapters.every(chapter => chapter.contentFormat === 'html')).toBe(true)
    expect(result.chapters[0].content).toContain('data:image/png;base64,')
    expect(result.chapters[0].content).not.toContain('<script')
    expect(result.chapters[0].content).not.toContain('onclick')
  }, 15_000)

  it.skipIf(!process.env.EPUB_TEST_FILE)('parses a real local EPUB from beginning to end', async () => {
    const sourcePath = process.env.EPUB_TEST_FILE!
    const source = await readFile(sourcePath)
    const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
    const startedAt = performance.now()
    let lastReportedProgress = -10
    const result = parseEpubBuffer(buffer, basename(sourcePath), ({ progress, message }) => {
      if (progress >= lastReportedProgress + 10) {
        lastReportedProgress = progress
        console.info('REAL_EPUB_PROGRESS', progress, message)
      }
    })
    const elapsedMs = Math.round(performance.now() - startedAt)

    expect(result.metadata.sourceFormat).toBe('epub')
    expect(result.metadata.title.length).toBeGreaterThan(0)
    expect(result.chapters.length).toBeGreaterThan(0)
    expect(result.chapters.every(chapter => chapter.contentFormat === 'html')).toBe(true)
    expect(result.chapters.some(chapter => chapter.wordCount > 0)).toBe(true)
    console.info('REAL_EPUB_RESULT', JSON.stringify({
      title: result.metadata.title,
      author: result.metadata.author,
      chapters: result.chapters.length,
      volumes: new Set(result.chapters.map(chapter => chapter.volume).filter(Boolean)).size,
      words: result.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
      hasCover: Boolean(result.metadata.coverDataUrl),
      warnings: result.warnings,
      elapsedMs
    }))
  }, 120_000)
})
