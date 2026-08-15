import { BrowserWindow, shell } from 'electron'
import type { SidecarState } from '../sidecar/sidecar-manager'
import { isAllowedNavigation, isSafeExternalUrl } from './navigation-guard'
import { WindowStateStore } from './window-state-store'

/** 主窗口（设计书 §3/§4/§9）：状态页 ↔ dsh 页切换、导航锁、外链转系统浏览器。 */
export class WindowController {
  private win: BrowserWindow | undefined
  private port: number | undefined
  private readonly store: WindowStateStore

  constructor(private readonly opts: {
    getState(): SidecarState
    onRetry(): void
    logDir: string
    preloadPath: string
    statusPagePath: string
    stateFile: string
  }) {
    this.store = new WindowStateStore(opts.stateFile)
  }

  get mainWindow(): BrowserWindow | undefined { return this.win }

  createMainWindow(): BrowserWindow {
    const bounds = this.store.load()
    this.win = new BrowserWindow({
      ...bounds, minWidth: 800, minHeight: 600, show: false,
      webPreferences: { preload: this.opts.preloadPath, contextIsolation: true },
    })
    this.win.once('ready-to-show', () => this.win?.show())
    this.win.on('close', () => { if (this.win !== undefined) this.store.save(this.win.getBounds()) })
    this.win.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url, this.port)) event.preventDefault()
    })
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      // 外链仅 http(s) 可交给系统浏览器（设计书 §9）：防止 ms-msdt: 等任意 scheme 触发 OS 处理器。
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    this.showStatus('launching')
    return this.win
  }

  loadDsh(port: number): void {
    // 端口每次重启都会变（设计书 §4）：总是 loadURL 新地址，不做 reload。
    this.port = port
    void this.win?.loadURL(`http://127.0.0.1:${port}`)
  }

  showStatus(kind: 'launching' | 'failed', detail?: string): void {
    this.port = kind === 'failed' ? undefined : this.port
    const query = { kind: kind === 'failed' ? 'failed' : 'launching', detail: detail ?? '' }
    // statusPagePath 可为 dev server 的 http URL（electron-vite dev）或打包产物文件路径：
    // 前者 loadURL + searchParams，后者 loadFile + query 选项。
    if (this.opts.statusPagePath.startsWith('http')) {
      const url = new URL(this.opts.statusPagePath)
      url.search = new URLSearchParams(query).toString()
      void this.win?.loadURL(url.href)
    } else {
      void this.win?.loadFile(this.opts.statusPagePath, { query })
    }
  }

  focus(): void {
    const win = this.win
    if (win === undefined) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}
