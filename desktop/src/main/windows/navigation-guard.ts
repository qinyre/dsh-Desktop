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

/**
 * 插件 IPC 门禁（设计书 §7"安装=对话框明示同意"、§9）：只认我们自己的插件页——
 * 打包产物（file:）或 dev server（localhost）。dsh 页跑在 sidecar 的 127.0.0.1 源上，
 * 其中含第三方 /plugins/<id>/client.js：整个 loopback 源一律拒绝，防止第三方脚本
 * 把主窗口导航到同路径的仿冒页后调用插件通道（终审 Important #4）。
 */
export function isPluginsPageSender(url: string): boolean {
  try {
    const { protocol, hostname, pathname } = new URL(url)
    const ownOrigin = protocol === 'file:' || ((protocol === 'http:' || protocol === 'https:') && hostname === 'localhost')
    return ownOrigin && pathname.endsWith('plugins/index.html')
  } catch {
    return false
  }
}
