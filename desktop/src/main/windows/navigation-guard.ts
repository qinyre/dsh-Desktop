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
