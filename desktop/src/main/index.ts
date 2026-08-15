import { app, BrowserWindow } from 'electron'

// Windows toast 通知必需：不设 AppUserModelId 的打包应用通知会静默不显示；
// 必须与 electron-builder.yml 的 appId 一致（Bug 3 修复）。
app.setAppUserModelId('com.dosket.desktop')

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1200, height: 800 })
  win.loadFile('out/renderer/status/index.html')
})
