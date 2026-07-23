import { describe, expect, it } from 'vitest'
import utils from './reader-utils.js'

describe('VS Code reader progress', () => {
  it('restores the visible line from chapter progress', () => {
    expect(utils.lineStartFromProgress(105, 0)).toBe(0)
    expect(utils.lineStartFromProgress(105, 50)).toBe(50)
    expect(utils.lineStartFromProgress(105, 100)).toBe(100)
    expect(utils.lineStartFromProgress(3, 80)).toBe(0)
  })

  it('clamps invalid progress values', () => {
    expect(utils.lineStartFromProgress(25, -10)).toBe(0)
    expect(utils.lineStartFromProgress(25, 120)).toBe(20)
  })
})
