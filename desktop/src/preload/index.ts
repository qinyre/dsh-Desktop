import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', {
  retry: (): void => { ipcRenderer.send('dsh:retry') },
  openLogs: (): void => { ipcRenderer.send('dsh:open-logs') },
  plugins: {
    list: (): Promise<string[]> => ipcRenderer.invoke('dsh:plugins:list'),
    run: (args: string[]): Promise<number> => ipcRenderer.invoke('dsh:plugins:run', args),
    restartSidecar: (): void => { ipcRenderer.send('dsh:restart-sidecar') },
  },
})

// pnpm 输出流（设计书 §7）：主进程逐行 webContents.send；隔离世界与主世界共享同一
// DOM，CustomEvent（字符串 detail 可结构化克隆）把行转发给插件对话框的 window 监听器。
ipcRenderer.on('dsh:plugins-output', (_event, line: string) => {
  window.dispatchEvent(new CustomEvent('dsh:plugins-output', { detail: line }))
})
