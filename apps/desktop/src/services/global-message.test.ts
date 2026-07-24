import { describe, expect, it } from 'vitest'
import { userFacingError } from './global-message'

describe('global Message copy', () => {
  it('does not expose raw English command output', () => {
    expect(userFacingError('Installing extensions... successfully installed.', '插件安装失败，请稍后重试'))
      .toBe('插件安装失败，请稍后重试')
  })

  it('keeps concise Chinese errors and removes diagnostic lines', () => {
    expect(userFacingError('未找到插件包，请重新检测\ncommand exited with code 1'))
      .toBe('未找到插件包，请重新检测')
  })

  it('falls back when a diagnostic is too long for a Message', () => {
    expect(userFacingError(`操作失败：${'详情'.repeat(100)}`, '操作失败，请稍后重试'))
      .toBe('操作失败，请稍后重试')
  })
})
