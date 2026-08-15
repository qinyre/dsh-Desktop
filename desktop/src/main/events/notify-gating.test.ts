import { describe, expect, it } from 'vitest'
import { shouldNotify } from './notify-gating'

describe('shouldNotify（仅窗口隐藏/失焦时通知，设计书 §6）', () => {
  it('gates on visibility or focus', () => {
    expect(shouldNotify(false, false)).toBe(true)  // 隐藏
    expect(shouldNotify(true, false)).toBe(true)   // 可见但失焦
    expect(shouldNotify(true, true)).toBe(false)   // 正在看着
  })
})
