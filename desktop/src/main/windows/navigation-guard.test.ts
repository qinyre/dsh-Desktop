import { describe, expect, it } from 'vitest'
import { isAllowedNavigation } from './navigation-guard'

describe('isAllowedNavigation（设计书 §9）', () => {
  it('allows only the live sidecar origin', () => {
    expect(isAllowedNavigation('http://127.0.0.1:45678/some/path', 45678)).toBe(true)
    expect(isAllowedNavigation('http://127.0.0.1:45678/', 45678)).toBe(true)
  })
  it('blocks stale ports, foreign origins, and file/data schemes', () => {
    expect(isAllowedNavigation('http://127.0.0.1:11111/', 45678)).toBe(false)
    expect(isAllowedNavigation('https://example.com/', 45678)).toBe(false)
    expect(isAllowedNavigation('file:///etc/passwd', 45678)).toBe(false)
  })
  it('blocks everything while no port is known', () => {
    expect(isAllowedNavigation('http://127.0.0.1:45678/', undefined)).toBe(false)
  })
})
