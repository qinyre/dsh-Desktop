import { dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { backupDshHome } from './backup-home'

/** 自动更新（设计书 §8）：自动下载、安装前询问；应用更新前备份 DSH_HOME。 */

/** feed 形态：URL（generic provider，本地/测试）或 GitHub Releases（默认）。 */
export type Feed = string | { provider: 'github'; owner: string; repo: string }

export class UpdaterController {
  constructor(private readonly opts: { feed?: Feed; dshHome: string; backupRoot: string }) {}

  start(): void {
    if (this.opts.feed === undefined || this.opts.feed === '') return // 显式置空：禁用更新检查
    autoUpdater.setFeedURL(this.opts.feed)
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
    // electron-updater 的下载/校验/安装失败以 'error' 事件抛出（EventEmitter error 无
    // 监听器=主进程未捕获异常，弱网下必炸）：与下方 checkForUpdates 的 catch 同级兜底。
    autoUpdater.on('error', (error) => {
      console.warn('[dsh-desktop] updater error:', String(error))
    })
    autoUpdater.checkForUpdates().catch((error) => {
      console.warn('[dsh-desktop] update check failed:', String(error)) // 离线/DNS/feed 不可达等失败仅记日志，不产生未处理 rejection
    })
  }
}
