import { describe, expect, it } from 'vitest'
import { NotifyCooldown } from './notify-cooldown'

describe('NotifyCooldown（每会话冷却）', () => {
  it('冷却窗口内第二条被拒、不同会话互不影响', () => {
    const cooldown = new NotifyCooldown(30_000)
    expect(cooldown.allow('a', 1_000)).toBe(true)
    expect(cooldown.allow('a', 20_000)).toBe(false)
    expect(cooldown.allow('b', 21_000)).toBe(true)
  })

  it('窗口过后重新放行，并刷新该会话的计时起点', () => {
    const cooldown = new NotifyCooldown(30_000)
    expect(cooldown.allow('a', 1_000)).toBe(true)
    expect(cooldown.allow('a', 31_000)).toBe(true)
    expect(cooldown.allow('a', 50_000)).toBe(false)
    expect(cooldown.allow('a', 61_001)).toBe(true)
  })
})
