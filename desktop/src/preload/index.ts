import { contextBridge, ipcRenderer } from 'electron'

// 插件管理已移交 Web UI 内的 dshmarket 插件（第三方包，预装进 profile）：
// 状态页只剩 重试 / 打开日志 两个通道；restartSidecar 供 Web UI 内的插件
// （如 dsh-plugin-install）把重启交还给壳层（sidecar 受应用监督，自重启会脱离）。
contextBridge.exposeInMainWorld('dshDesktop', {
  retry: (): void => { ipcRenderer.send('dsh:retry') },
  openLogs: (): void => { ipcRenderer.send('dsh:open-logs') },
  restartSidecar: (): void => { ipcRenderer.send('dsh:restart-sidecar') },
})

// 标题栏跟随主题（仅 dsh 页；状态页由主进程固定配色）：上报页面实际背景色。
// dsh 切主题会改 html.style.colorScheme 与 body 的 data-ds-dark-theme
// （ui-theme 的 boot-theme/ThemePresenter），监听这两处 + 轮询兜底。
if (location.hostname === '127.0.0.1') {
  const report = (): void => {
    const candidates = [
      getComputedStyle(document.body).backgroundColor,
      getComputedStyle(document.documentElement).backgroundColor,
    ]
    for (const css of candidates) {
      // 透明背景（rgba(...,0)）跳过，取下一个候选。
      if (css.startsWith('rgb') && !css.endsWith(', 0)')) {
        ipcRenderer.send('dsh:titlebar-color', css)
        return
      }
    }
  }
  new MutationObserver(report).observe(document.documentElement, {
    attributes: true, attributeFilter: ['style'],
  })
  new MutationObserver(report).observe(document.body, {
    attributes: true, attributeFilter: ['data-ds-dark-theme'],
  })
  document.addEventListener('DOMContentLoaded', report)
  setInterval(report, 5000)
}
