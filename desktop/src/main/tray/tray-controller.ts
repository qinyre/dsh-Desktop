import { BrowserWindow, Menu, Tray, app, shell } from 'electron'
import { closeAction } from './close-behavior'

/** 托盘（设计书 §5）：显示 / 打开日志目录 / 插件管理 / 退出。 */
export class TrayController {
  private tray: Tray | undefined
  private trayHintShown = false
  private quiting = false

  constructor(private readonly opts: { iconPath: string; logDir: string; onShow(): void; onPlugins(): void; onQuit(): void }) {}

  attach(win: BrowserWindow): void {
    this.tray = new Tray(this.opts.iconPath)
    this.tray.setToolTip('Dosket')
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => this.opts.onShow() },
      { label: '打开日志目录', click: () => { void shell.openPath(this.opts.logDir) } },
      { label: '插件管理…', click: () => this.opts.onPlugins() },
      { type: 'separator' },
      { label: '退出', click: () => { this.quiting = true; this.opts.onQuit() } },
    ]))
    this.tray.on('double-click', () => this.opts.onShow())
    win.on('close', (event) => {
      if (closeAction({ quiting: this.quiting }) === 'hide') {
        event.preventDefault()
        win.hide()
        if (!this.trayShownOnce()) { this.tray?.displayBalloon({ title: 'Dosket', content: '已最小化到托盘' }) }
        this.trayHintShown = true
      }
    })
    app.on('before-quit', () => { this.quiting = true })
  }

  private trayShownOnce(): boolean { return this.trayHintShown }

  destroy(): void {
    this.tray?.destroy()
    this.tray = undefined
  }
}
