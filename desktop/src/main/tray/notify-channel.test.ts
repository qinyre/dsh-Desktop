import { describe, expect, it } from 'vitest'
import { resolveNotifyChannel } from './notify-channel'

describe('resolveNotifyChannel（win32 气泡 / 其余按探测走 Notification / 未知为 none）', () => {
  it('win32 always uses the tray balloon regardless of the probe', () => {
    expect(resolveNotifyChannel({ platform: 'win32', notificationsAvailable: true })).toBe('balloon')
    expect(resolveNotifyChannel({ platform: 'win32', notificationsAvailable: false })).toBe('balloon')
  })
  it('other platforms use Electron Notification only when the daemon was confirmed', () => {
    expect(resolveNotifyChannel({ platform: 'linux', notificationsAvailable: true })).toBe('notification')
    expect(resolveNotifyChannel({ platform: 'linux', notificationsAvailable: false })).toBe('none')
    expect(resolveNotifyChannel({ platform: 'darwin', notificationsAvailable: false })).toBe('none')
  })
})
