import { describe, expect, it } from 'vitest'
import { closeAction } from './close-behavior'

describe('closeAction（设计书 §5：关闭=隐藏到托盘；退出走托盘菜单；无托盘环境退化为真实退出）', () => {
  it('hides when the tray is available and the app is not quitting', () => {
    expect(closeAction({ quiting: false, trayAvailable: true })).toBe('hide')
  })
  it('quits when app is quitting (tray menu exit / before-quit)', () => {
    expect(closeAction({ quiting: true, trayAvailable: true })).toBe('quit')
  })
  it('quits when the tray is unavailable — hiding would lose the window with no way back', () => {
    expect(closeAction({ quiting: false, trayAvailable: false })).toBe('quit')
  })
  it('quitting wins regardless of tray availability', () => {
    expect(closeAction({ quiting: true, trayAvailable: false })).toBe('quit')
  })
})
