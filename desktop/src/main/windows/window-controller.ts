import { BrowserWindow, screen, shell } from 'electron'
import type { Rectangle } from 'electron'
import { join } from 'node:path'
import type { SidecarState } from '../sidecar/sidecar-manager'
import { isAllowedNavigation, isSafeExternalUrl } from './navigation-guard'
import { applyTitleBarColor, parseCssColor } from './titlebar-color'
import { WindowStateStore } from './window-state-store'

/** 状态页标题栏色：其深海渐变的顶端色调（#0c1e30）。 */
const STATUS_BAR_COLOR = 'rgb(12, 30, 48)'

/** 主窗口（设计书 §3/§4/§9）：状态页 ↔ dsh 页切换、导航锁、外链转系统浏览器。 */
export class WindowController {
  private win: BrowserWindow | undefined
  private port: number | undefined
  private lastBarColor = ''
  /** 状态页当前展示的活动文本；dsh 页加载后不再推送（页面没有消费元素）。 */
  private activity = ''
  private showingStatus = true
  /** dsh 页最近一次加载/reload 时刻（0=从未）；客户端 boot 失败的重载窗口据此判定。 */
  private lastDshLoadAt = 0
  private readonly store: WindowStateStore

  constructor(private readonly opts: {
    getState(): SidecarState
    onRetry(): void
    logDir: string
    preloadPath: string
    statusPagePath: string
    stateFile: string
    /**
     * dsh 页渲染器的 error 级 console 输出（仅 dsh 页在场时转发；status 页共用同一
     * webContents 不转发）。客户端插件树 boot 失败只走浏览器 console（宿主零感知），
     * 这是主进程能拿到它的唯一通道。
     */
    onConsoleMessage?: (text: string) => void
  }) {
    this.store = new WindowStateStore(opts.stateFile)
  }

  get mainWindow(): BrowserWindow | undefined { return this.win }

  /**
   * 恢复的窗口坐标可能在屏外（拔掉的显示器、缩水后的分辨率）：夹进最近显示器的
   * 工作区再应用——整体出界即落回该工作区左上角，尺寸超工作区则收进工作区。
   * Electron 耦合（screen 模块），不设单测，靠打包后手测披露。
   */
  private clampToVisibleDisplay(bounds: Rectangle): Rectangle {
    const area = screen.getDisplayMatching(bounds).workArea
    const width = Math.min(bounds.width, area.width)
    const height = Math.min(bounds.height, area.height)
    return {
      x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
      width, height,
    }
  }

  createMainWindow(): BrowserWindow {
    this.win = new BrowserWindow({
      ...this.clampToVisibleDisplay(this.store.load()), minWidth: 800, minHeight: 600, show: false,
      title: 'DSH Desktop',
      // Linux 的窗口/任务栏图标不跟随可执行文件（Windows 从 exe 取）：不显式传会退化成
      // Electron 默认图。win32 保持不传，任务栏沿用安装器图标，零变化。
      icon: process.platform === 'win32' ? undefined : join(__dirname, '../../resources/icon.png'),
      webPreferences: { preload: this.opts.preloadPath, contextIsolation: true },
    })
    this.win.once('ready-to-show', () => this.win?.show())
    // dsh 的 Web UI 会把 document.title 设为 "DeepSeek Harness"：任务栏/标题栏保持本应用名。
    this.win.on('page-title-updated', (event) => event.preventDefault())
    this.win.on('close', () => { if (this.win !== undefined) this.store.save(this.win.getBounds()) })
    this.win.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url, this.port)) event.preventDefault()
    })
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      // 外链仅 http(s) 可交给系统浏览器（设计书 §9）：防止 ms-msdt: 等任意 scheme 触发 OS 处理器。
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // 客户端插件树 boot 失败遥测：只认 error 级且仅 dsh 页在场时转发（status 页共用
    // webContents；info/warn 里回显旧日志的插件会误触签名门）。
    this.win.webContents.on('console-message', (details) => {
      if (this.showingStatus || details.level !== 'error') return
      this.opts.onConsoleMessage?.(details.message)
    })
    this.showStatus('launching')
    this.setTitleBarColor(STATUS_BAR_COLOR)
    return this.win
  }

  loadDsh(port: number, token: string | undefined): void {
    // 端口每次重启都会变（设计书 §4）：总是 loadURL 新地址，不做 reload。
    this.port = port
    this.showingStatus = false
    this.lastDshLoadAt = Date.now()
    // 0.1.2-alpha 起 webserver 全量鉴权：首载带进程令牌（GET /?token= → 303 铸
    // HttpOnly 会话 cookie），此后同源请求/reload 自动携带；旧运行时无令牌按裸 URL。
    const url = token === undefined
      ? `http://127.0.0.1:${port}`
      : `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
    void this.win?.loadURL(url)
  }

  /**
   * dsh 页距最近一次加载/reload 的毫秒数；status 页在场或从未加载过返回 undefined。
   * 客户端 boot 失败的自动 reload 只允许发生在加载后的短窗内（boot 失败），会话中段
   * 的同类失败只报告不打断用户。
   */
  dshLoadAge(): number | undefined {
    if (this.showingStatus || this.lastDshLoadAt === 0) return undefined
    return Date.now() - this.lastDshLoadAt
  }

  /** 受控 reload 当前 dsh 页（客户端清单按页烘焙，隔离行写入后须重载才生效）。 */
  reloadDshPage(): boolean {
    if (this.showingStatus || this.win === undefined) return false
    this.lastDshLoadAt = Date.now()
    this.win.webContents.reload()
    return true
  }

  showStatus(kind: 'launching' | 'failed', detail?: string): void {
    this.port = kind === 'failed' ? undefined : this.port
    this.showingStatus = true
    // 状态页自己接管标题栏配色（dsh 页可能已按其主题改过）。
    this.setTitleBarColor(STATUS_BAR_COLOR)
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

  /**
   * 状态页的活动文本（预装进度等）：记下当前值供页面加载后拉取，且仅在状态页
   * 在场时推送——dsh 页共用同一 preload，没有消费元素，推过去是噪音。
   */
  showActivity(text: string): void {
    this.activity = text
    if (this.showingStatus) this.win?.webContents.send('dsh:activity', text)
  }

  getActivity(): string {
    return this.activity
  }

  /**
   * 标题栏跟随主题上色（Windows DWM；其余平台/失败静默保持系统默认）。
   * dsh 页加载后由 preload 上报页面实际背景色（见 preload 的 titlebar reporter），
   * 状态页固定用 STATUS_BAR_COLOR。
   */
  setTitleBarColor(css: string): void {
    const rgb = parseCssColor(css)
    if (rgb === null || css === this.lastBarColor || this.win === undefined) return
    this.lastBarColor = css
    applyTitleBarColor(this.win, rgb)
  }
}
