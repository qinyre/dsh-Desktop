import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { backupDshHome } from './backup-home'

/** 自动更新（设计书 §8）：自动下载、安装前询问；应用更新前备份 DSH_HOME。 */

/** feed 形态：URL（generic provider，本地/测试）或 GitHub Releases（默认）。 */
export type Feed = string | { provider: 'github'; owner: string; repo: string }

const NET_RETRY_ATTEMPTS = 3

/** 弱网/防火墙干扰下 GitHub 更新链路会间歇性被掐断（net::ERR_CONNECTION_CLOSED 等），这类瞬时失败自动重试。 */
export function isTransientNetError(error: unknown): boolean {
  const text = String(error)
  return /net::ERR_(CONNECTION|INTERNET_DISCONNECTED|TIMED_OUT|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE)/i.test(text)
    || /\b(ECONNRESET|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/.test(text)
}

/** 弹窗里的简短失败原因：常见网络错误给一句人话，其余截断原始串（HttpError 会把整段响应头字符串化）。 */
export function describeCheckError(error: unknown): string {
  const text = String(error)
  if (/ERR_CONNECTION_(CLOSED|RESET)|ECONNRESET/i.test(text)) return '到更新服务器的连接被中断（网络不稳定），可稍后重试'
  if (/ERR_INTERNET_DISCONNECTED/i.test(text)) return '当前没有网络连接'
  if (/TIMED_OUT/i.test(text)) return '连接更新服务器超时，可稍后重试'
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class UpdaterController {
  private checking = false

  constructor(private readonly opts: { feed?: Feed; dshHome: string; backupRoot: string }) {}

  /**
   * 托盘「检查更新」：手动触发一次检查，结果以对话框反馈。瞬时网络失败自动重试
   * （NET_RETRY_ATTEMPTS 次，间隔递增）；非瞬时错误（如清单缺失 404）不重试直接反馈。
   * checking 单飞：启动检查与手动点击、连点并发时只跑一个，其余静默忽略（electron-updater
   * 自身不排队，并发检查会互相打断报错）。
   */
  async checkNow(): Promise<void> {
    if (!this.opts.feed) {
      await dialog.showMessageBox({ type: 'info', title: '检查更新', message: '当前构建未启用更新检查。', buttons: ['好'] })
      return
    }
    if (this.checking) return
    this.checking = true
    try {
      for (let attempt = 1; ; attempt++) {
        let result
        try {
          result = await autoUpdater.checkForUpdates()
        } catch (error) {
          if (attempt < NET_RETRY_ATTEMPTS && isTransientNetError(error)) {
            await sleep(2000 * attempt)
            continue
          }
          await dialog.showMessageBox({ type: 'warning', title: '检查更新', message: `检查失败：${describeCheckError(error)}`, buttons: ['好'] })
          return
        }
        const latest = result?.updateInfo.version
        if (latest !== undefined && latest !== app.getVersion()) {
          await dialog.showMessageBox({ type: 'info', title: '发现新版本', message: `发现新版本 ${latest}，正在后台下载，完成后会询问是否安装。`, buttons: ['好'] })
        } else {
          await dialog.showMessageBox({ type: 'info', title: '检查更新', message: `当前已是最新版本（${app.getVersion()}）。`, buttons: ['好'] })
        }
        return
      }
    } finally {
      this.checking = false
    }
  }

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
    // 监听器=主进程未捕获异常，弱网下必炸）：与下方检查的 catch 同级兜底。
    autoUpdater.on('error', (error) => {
      console.warn('[dsh-desktop] updater error:', String(error))
    })
    void this.silentStartupCheck()
  }

  /** 开机后台检查：与 checkNow 同样的瞬时错误重试，但全程静默（仅日志，不打扰用户）。 */
  private async silentStartupCheck(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await autoUpdater.checkForUpdates()
        return
      } catch (error) {
        if (attempt < NET_RETRY_ATTEMPTS && isTransientNetError(error)) {
          await sleep(2000 * attempt)
          continue
        }
        console.warn('[dsh-desktop] update check failed:', String(error)) // 离线/DNS/feed 不可达等失败仅记日志，不产生未处理 rejection
        return
      }
    }
  }
}
