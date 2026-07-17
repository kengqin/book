import { describe, expect, it } from 'vitest'
import { calculateOverallProgress, formatChapterLabel, getCompactReaderWindow, splitReaderLines } from './index'

describe('reader core', () => {
  it('formats numeric and Chinese chapter labels', () => {
    expect(formatChapterLabel({ number: 1, originalLabel: '12' })).toBe('第12章')
    expect(formatChapterLabel({ number: 2, originalLabel: '十二' })).toBe('第十二章')
    expect(formatChapterLabel({ number: 3, originalLabel: '番外一' })).toBe('番外一')
  })

  it('calculates and clamps overall progress', () => {
    expect(calculateOverallProgress(2, 50, 4)).toBe(37.5)
    expect(calculateOverallProgress(4, 120, 4)).toBe(100)
    expect(calculateOverallProgress(0, -10, 0)).toBe(0)
  })

  it('creates stable compact reading windows', () => {
    const text = '第一行正文\n第二行正文\n第三行正文'
    const lines = splitReaderLines(text, 20)
    expect(lines).toHaveLength(3)
    const window = getCompactReaderWindow(text, lines[1].start, 2, 20)
    expect(window.lines.map(line => line.text)).toEqual(['第二行正文', '第三行正文'])
    expect(window.anchor).toBe(lines[1].start)
  })
})
