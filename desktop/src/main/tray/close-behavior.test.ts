import { describe, expect, it } from 'vitest'
import { closeAction } from './close-behavior'

describe('closeAction（设计书 §5：关闭=隐藏到托盘；退出走托盘菜单）', () => {
  it('hides unless the app is quitting', () => {
    expect(closeAction({ quiting: false })).toBe('hide')
  })
  it('quits when app is quitting', () => {
    expect(closeAction({ quiting: true })).toBe('quit')
  })
})
