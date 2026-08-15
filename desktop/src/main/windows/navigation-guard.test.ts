import { describe, expect, it } from 'vitest'
import { isAllowedNavigation, isPluginsPageSender, isSafeExternalUrl } from './navigation-guard'

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

describe('isPluginsPageSender（终审 Important #4：插件通道只认插件页自身）', () => {
  it('accepts the packaged plugins page and the dev-server plugins page', () => {
    expect(isPluginsPageSender('file:///C:/app/out/renderer/plugins/index.html')).toBe(true)
    expect(isPluginsPageSender('http://localhost:5173/plugins/index.html')).toBe(true)
  })
  it('rejects the dsh origin entirely (incl. same-path lookalikes and third-party plugin assets)', () => {
    expect(isPluginsPageSender('http://127.0.0.1:45678/')).toBe(false)
    expect(isPluginsPageSender('http://127.0.0.1:45678/plugins/index.html')).toBe(false) // 仿冒同路径页
    expect(isPluginsPageSender('http://127.0.0.1:45678/plugins/my-plugin/client.js')).toBe(false)
  })
  it('rejects other hosts and non-URLs', () => {
    expect(isPluginsPageSender('http://example.com/plugins/index.html')).toBe(false)
    expect(isPluginsPageSender('https://localhost:5173/other/index.html')).toBe(false)
    expect(isPluginsPageSender('not a url')).toBe(false)
  })
})
