import fs from 'node:fs'
import path from 'node:path'
import { writeLibraryManifest } from './generate-library.mjs'

const workspace = path.resolve(import.meta.dirname, '..')
const bookDir = path.join(workspace, '书库', '雪中悍刀行')
const sourcePath = path.join(bookDir, '原文', '雪中悍刀行.txt')
const outputDir = path.join(bookDir, '正文')
const dryRun = process.argv.includes('--dry-run')

function safeTitle(value) {
  return value.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')
}

function cleanParagraphs(body) {
  const paragraphs = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/^[ \t　]+/, '').trimEnd()
    if (!line) continue
    if (/^[，。！？；：、）》”’…]/.test(line) && paragraphs.length) {
      paragraphs[paragraphs.length - 1] += line
    } else {
      paragraphs.push(line)
    }
  }
  return paragraphs.join('\n\n').trim()
}

if (!fs.existsSync(sourcePath)) throw new Error(`找不到原文：${sourcePath}`)

const source = new TextDecoder('gb18030')
  .decode(fs.readFileSync(sourcePath))
  .replace(/^\uFEFF/, '')
  .replace(/\r\n?/g, '\n')

const volumePattern = /^第([一二三四五六七八九十]+)卷[ \t　]+([^\n]+)$/gm
const volumes = [...source.matchAll(volumePattern)]
if (!volumes.length) throw new Error('未识别到卷标题')

const chapters = []
const volumeSummary = []

for (let volumeIndex = 0; volumeIndex < volumes.length; volumeIndex += 1) {
  const volume = volumes[volumeIndex]
  const segmentStart = volume.index + volume[0].length
  const segmentEnd = volumes[volumeIndex + 1]?.index ?? source.length
  const segment = source.slice(segmentStart, segmentEnd)
  const headerPattern = /^第\s*(\d{1,4})\s*章[ \t　]+([^\n]+)$/gm
  const headers = [...segment.matchAll(headerPattern)]
  const volumeName = safeTitle(volume[2])

  headers.forEach((header, chapterIndex) => {
    const localNumber = Number(header[1])
    const expected = chapterIndex + 1
    if (localNumber !== expected) {
      throw new Error(`第${volumeIndex + 1}卷章号不连续：预期 ${expected}，实际 ${localNumber}`)
    }
    const start = header.index + header[0].length
    const end = headers[chapterIndex + 1]?.index ?? segment.length
    chapters.push({
      number: chapters.length + 1,
      localNumber,
      title: safeTitle(header[2]),
      volumeNumber: volumeIndex + 1,
      volumeName,
      body: cleanParagraphs(segment.slice(start, end))
    })
  })

  volumeSummary.push({
    volume: volumeIndex + 1,
    title: volumeName,
    chapters: headers.length
  })
}

const summary = {
  encoding: 'gb18030',
  volumes: volumeSummary,
  chapters: chapters.length,
  firstChapter: chapters[0]?.title,
  lastChapter: chapters.at(-1)?.title
}

if (dryRun) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exit(0)
}

const resolvedOutput = path.resolve(outputDir)
if (!resolvedOutput.startsWith(`${path.resolve(bookDir)}${path.sep}`) || path.basename(resolvedOutput) !== '正文') {
  throw new Error(`拒绝清理非预期目录：${resolvedOutput}`)
}

fs.rmSync(resolvedOutput, { recursive: true, force: true })
fs.mkdirSync(resolvedOutput, { recursive: true })

for (const chapter of chapters) {
  const volumeDirName = `第${chapter.volumeNumber}卷-${chapter.volumeName}`
  const volumeDir = path.join(resolvedOutput, volumeDirName)
  const filename = `第${String(chapter.number).padStart(4, '0')}章-${safeTitle(chapter.title).replace(/\s+/g, '-')}.md`
  fs.mkdirSync(volumeDir, { recursive: true })
  fs.writeFileSync(
    path.join(volumeDir, filename),
    `# 第${chapter.number}章 ${chapter.title}\n\n${chapter.body}\n`,
    'utf8'
  )
}

writeLibraryManifest()
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

