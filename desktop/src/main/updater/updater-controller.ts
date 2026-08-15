import { dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { backupDshHome } from './backup-home'

/** 自动更新（设计书 §8）：自动下载、安装前询问；应用更新前备份 DSH_HOME。 */
export class UpdaterController {
  constructor(private readonly opts: { feedUrl?: string; dshHome: string; backupRoot: string }) {}

  start(): void {
    if (this.opts.feedUrl === undefined || this.opts.feedUrl === '') return // dev：无 feed，静默跳过
    autoUpdater.setFeedURL(this.opts.feedUrl)
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false // 设计书 §8"安装前询问"：安装只能由用户点"立即安装"触发，选"稍后"后退出不得静默安装
    autoUpdater.on('update-downloaded', async (info) => {
      const choice = await dialog.showMessageBox({
        type: 'info', title: '更新已就绪',
        message: `版本 ${info.version} 已下载。安装前会自动备份会话与凭据数据。`,
        buttons: ['稍后', '立即安装'], defaultId: 1,
      })
      if (choice.response === 1) {
        await backupDshHome(this.opts.dshHome, this.opts.backupRoot)
        autoUpdater.quitAndInstall()
      }
    })
    autoUpdater.checkForUpdates().catch((error) => {
      console.warn('[dosket] update check failed:', String(error)) // 离线/DNS/feed 不可达等失败仅记日志，不产生未处理 rejection
    })
  }
}
