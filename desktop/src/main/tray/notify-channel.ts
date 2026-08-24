/**
 * 托盘/事件通知的渠道决策（纯函数）。
 * win32：Tray.displayBalloon（Windows-only，历来行为）。
 * 其余平台：Electron Notification（依赖桌面通知守护，经 DBus 探测确认后才可用）。
 * 探测未确认（无守护/工具缺失）= none：跳过通知——比「尝试后挂起/抛错」安全
 * （Electron 在无通知守护环境有已知挂起问题 electron#21912）。
 */
export function resolveNotifyChannel(opts: { platform: NodeJS.Platform; notificationsAvailable: boolean }): 'balloon' | 'notification' | 'none' {
  if (opts.platform === 'win32') return 'balloon'
  return opts.notificationsAvailable ? 'notification' : 'none'
}
