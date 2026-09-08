import { describe, expect, it } from 'vitest'
import { interpolatePage, pageTurnFrame } from './startup-animation'

describe('startup page animation', () => {
  it('holds the landed page without fading or changing geometry', () => {
    for (const phase of [.78, .86, .90, .92, .94, 1]) {
      expect(pageTurnFrame(phase)).toEqual(pageTurnFrame(.76))
      expect(pageTurnFrame(phase).sheet.opacity).toBe(1)
    }
  })
  it('uses one connected sheet anchored at both ends of the spine', () => {
    for (let i = 0; i <= 100; i++) {
      const frame = pageTurnFrame(i / 100)
      expect(Object.keys(frame)).toEqual(['sheet'])
      expect(frame.sheet.d).toMatch(/^path\("M32\.0000 22\.0000 C/)
      expect(frame.sheet.d).toContain('32.0000 50.0000 Z')
    }
  })
  it('interpolates through poses without stopping at each pose', () => {
    const poses = ['M0 0', 'M10 0', 'M20 0', 'M30 0', 'M40 0']
    const x = (t: number) => Number(interpolatePage(poses, t).match(/-?\d+(?:\.\d+)?/)![0])
    for (const t of [.25, .5, .75]) {
      const before = x(t) - x(t - .001)
      const after = x(t + .001) - x(t)
      expect(before).toBeGreaterThan(.03)
      expect(after).toBeCloseTo(before, 3)
    }
  })
  it('produces finite geometry and valid opacity over the entire cycle', () => {
    for (let i = 0; i <= 1000; i++) {
      for (const frame of Object.values(pageTurnFrame(i / 1000))) {
        expect(frame.d).not.toMatch(/NaN|Infinity/)
        expect(frame.opacity).toBe(1)
      }
    }
  })
})
