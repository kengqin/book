import { describe, expect, it } from 'vitest'
import { calculateOverallProgress, formatChapterLabel } from './index'

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
})
