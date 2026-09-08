export type ReaderPalette = 'light' | 'paper' | 'ivory' | 'night'
export const readerWidths = ['auto', 640, 800, 900, 1000, 1280] as const
export type ReaderWidth = typeof readerWidths[number]
export function normalizeReaderWidth(value: unknown): ReaderWidth {
  return readerWidths.includes(value as ReaderWidth) ? value as ReaderWidth : 800
}
export const readerFonts = {
  original: { label: '思源宋体', family: undefined },
  hei: { label: '黑体', family: '"Microsoft YaHei", "PingFang SC", SimHei, sans-serif' },
  song: { label: '宋体', family: 'SimSun, "Songti SC", "Noto Serif SC", serif' },
  kai: { label: '楷体', family: 'KaiTi, STKaiti, "Kaiti SC", cursive' },
} as const
export type ReaderFont = keyof typeof readerFonts
export function normalizeReaderFont(value: unknown): ReaderFont {
  return typeof value === 'string' && Object.hasOwn(readerFonts, value) ? value as ReaderFont : 'original'
}
