/** 导航白名单（设计书 §9）：仅允许当前就绪端口的 loopback 源。 */
export function isAllowedNavigation(url: string, port: number | undefined): boolean {
  if (port === undefined) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port === String(port)
  } catch {
    return false
  }
}

/** 外链仅允许 http(s) 交给系统浏览器（设计书 §9；其余 scheme 一律丢弃）。 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
