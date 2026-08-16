import { contextBridge, ipcRenderer } from 'electron'

// 插件管理已移交 Web UI 内的 dshmarket 插件（第三方包，预装进 profile）：
// 状态页只剩 重试 / 打开日志 两个通道。
contextBridge.exposeInMainWorld('dshDesktop', {
  retry: (): void => { ipcRenderer.send('dsh:retry') },
  openLogs: (): void => { ipcRenderer.send('dsh:open-logs') },
})
