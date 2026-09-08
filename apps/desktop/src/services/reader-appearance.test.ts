import { describe, expect, it } from 'vitest'
import { normalizeReaderFont, readerFonts } from './reader-appearance'

describe('reader font preferences', () => {
  it('preserves existing mixed fonts for old or invalid preferences', () => {
    for (const value of [undefined, null, '', 'unknown', '__proto__', 'toString', 1]) {
      expect(normalizeReaderFont(value)).toBe('original')
    }
    expect(readerFonts.original.family).toBeUndefined()
  })

  it('restores each supported choice', () => {
    for (const key of Object.keys(readerFonts)) expect(normalizeReaderFont(key)).toBe(key)
    for (const key of ['hei', 'song', 'kai'] as const) expect(readerFonts[key].family).toBeTruthy()
    expect(normalizeReaderFont('song')).toBe('song')
    expect(readerFonts.original.label).toBe('思源宋体')
  })
})
