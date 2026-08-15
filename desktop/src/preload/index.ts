import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dosket', {
  retry: (): void => { ipcRenderer.send('dosket:retry') },
  openLogs: (): void => { ipcRenderer.send('dosket:open-logs') },
  plugins: {
    list: (): Promise<string[]> => ipcRenderer.invoke('dosket:plugins:list'),
    run: (args: string[]): Promise<number> => ipcRenderer.invoke('dosket:plugins:run', args),
    restartSidecar: (): void => { ipcRenderer.send('dosket:restart-sidecar') },
  },
})

// pnpm 输出流（设计书 §7）：主进程逐行 webContents.send；隔离世界与主世界共享同一
// DOM，CustomEvent（字符串 detail 可结构化克隆）把行转发给插件对话框的 window 监听器。
ipcRenderer.on('dosket:plugins-output', (_event, line: string) => {
  window.dispatchEvent(new CustomEvent('dosket:plugins-output', { detail: line }))
})
