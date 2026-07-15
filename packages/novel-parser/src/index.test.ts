import { describe, expect, it } from 'vitest'
import { defaultParseOptions } from '@novel-library/reader-core'
import { detectEncoding, parseNovel } from './index'

function utf8(value: string) {
  return new TextEncoder().encode(value).buffer
}

describe('novel parser', () => {
  it('parses metadata, volumes and chapters without changing the existing rules', () => {
    const result = parseNovel({
      filename: '备用书名.txt',
      buffer: utf8(`《山海书》\n作者：测试作者\n内容简介\n这是简介。\n\n第一卷 初见\n第一章 起程\n第一段没有句号\n接续内容。\n更多精彩小说尽在这里\n第二章 风雨\n第二章正文。`),
      options: defaultParseOptions
    })

    expect(result.metadata.title).toBe('山海书')
    expect(result.metadata.author).toBe('测试作者')
    expect(result.metadata.description).toBe('这是简介。')
    expect(result.chapters).toHaveLength(2)
    expect(result.chapters[0]).toMatchObject({ originalLabel: '一', title: '起程', volume: '第一卷 初见' })
    expect(result.chapters[0].content).toBe('第一段没有句号接续内容。')
    expect(result.chapters[1].title).toBe('风雨')
  })

  it('falls back to a single chapter when no heading is found', () => {
    const result = parseNovel({ filename: '散文.txt', buffer: utf8('只有一段正文。'), options: defaultParseOptions })

    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0].content).toBe('只有一段正文。')
    expect(result.warnings[0]).toContain('未检测到章节标题')
  })

  it('detects UTF-16 LE from its byte order mark', () => {
    const body = Buffer.from('第一章 测试', 'utf16le')
    const bytes = new Uint8Array(body.length + 2)
    bytes.set([0xff, 0xfe])
    bytes.set(body, 2)

    expect(detectEncoding(bytes.buffer, 'auto')).toBe('utf-16le')
  })
})
