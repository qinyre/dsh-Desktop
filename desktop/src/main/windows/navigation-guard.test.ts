import { describe, expect, it } from 'vitest'
import { isAllowedNavigation, isSafeExternalUrl } from './navigation-guard'

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

describe('isSafeExternalUrl（设计书 §9）', () => {
  it('allows only http(s) URLs handed to the system browser', () => {
    expect(isSafeExternalUrl('https://example.com/')).toBe(true)
    expect(isSafeExternalUrl('http://127.0.0.1:1/x')).toBe(true)
  })
  it('blocks OS scheme handlers, file, javascript, and non-URLs', () => {
    expect(isSafeExternalUrl('ms-msdt:foo')).toBe(false)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
  })
})
