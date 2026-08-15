import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dosket', {
  retry: (): void => { ipcRenderer.send('dosket:retry') },
  openLogs: (): void => { ipcRenderer.send('dosket:open-logs') },
})
