import { BrowserWindow, Menu, Tray, app, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { closeAction } from './close-behavior'

/**
 * 托盘（设计书 §5）：显示 / 插件管理 / 重启服务 / 检查更新 / 打开日志目录 / 退出。
 * 插件管理是架构级逃生通道（页面打不开时唯一可用的管理入口），分区由 tray-plugin-section
 * 每次现读磁盘构建；外部写入经 fs.watch 触发 refresh() 重建菜单。
 */
export class TrayController {
  private tray: Tray | undefined
  private trayHintShown = false
  private quiting = false

  constructor(private readonly opts: {
    iconPath: string
    logDir: string
    onShow(): void
    onRestart(): void
    onCheckUpdates(): void
    onGuardReport(): void
    onQuit(): void
    /** 插件管理分区（dshHome 可用时注入）；缺省或返回 undefined 时菜单不含该段。 */
    pluginSection?: () => MenuItemConstructorOptions | undefined
  }) {}

  attach(win: BrowserWindow): void {
    this.tray = new Tray(this.opts.iconPath)
    this.tray.setToolTip('DSH Desktop')
    this.tray.setContextMenu(this.buildMenu())
    this.tray.on('double-click', () => this.opts.onShow())
    win.on('close', (event) => {
      if (closeAction({ quiting: this.quiting }) === 'hide') {
        event.preventDefault()
        win.hide()
        if (!this.trayShownOnce()) { this.tray?.displayBalloon({ title: 'DSH Desktop', content: '已最小化到托盘' }) }
        this.trayHintShown = true
      }
    })
    app.on('before-quit', () => { this.quiting = true })
  }

  private buildMenu(): Menu {
    const template: MenuItemConstructorOptions[] = [
      { label: '显示主窗口', click: () => this.opts.onShow() },
    ]
    const section = this.opts.pluginSection?.()
    if (section !== undefined) template.push(section)
    template.push(
      // 「重启服务」承接市场安装后的待重启提示（market 自重启已通过配置关闭），也兜底
      // 插件管理动作后的手动完整生效。
      { label: '重启服务', click: () => this.opts.onRestart() },
      // 插件守卫的隔离台账（启动时自动隔离过问题插件时，随时可回看/重新启用）。
      { label: '插件隔离报告', click: () => this.opts.onGuardReport() },
      // 手动触发一次更新检查（结果对话框反馈）；启动时的被动检查见 updater-controller.start()。
      { label: '检查更新', click: () => this.opts.onCheckUpdates() },
      { label: '打开日志目录', click: () => { void shell.openPath(this.opts.logDir) } },
      { type: 'separator' },
      { label: '退出', click: () => { this.quiting = true; this.opts.onQuit() } },
    )
    return Menu.buildFromTemplate(template)
  }

  /** 用当前状态重建菜单（插件启停/外部写入后调用；attach 前为空操作）。 */
  refresh(): void {
    if (this.tray === undefined) return
    this.tray.setContextMenu(this.buildMenu())
  }

  private trayShownOnce(): boolean { return this.trayHintShown }

  /**
   * 托盘气泡通知（运行期新隔离等；Windows-only API，其余平台/未 attach 时静默——
   * 托盘「插件隔离报告」仍在）。自身绝不抛错。
   */
  notify(title: string, content: string): void {
    try {
      this.tray?.displayBalloon({ title, content })
    } catch {
      /* displayBalloon 不可用（非 Windows/托盘已销毁）：静默 */
    }
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = undefined
  }
}
