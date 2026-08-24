import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { dialog } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { buildPluginSection, disableAllPlugins, enableAllPlugins, listManagedPlugins, restoreBundle, setPluginEnabled } from '../plugins/tray-plugin-manager'

/**
 * 「插件管理」托盘分区的 electron 耦合层：菜单构建（每次现读磁盘）、确认对话框、
 * 动作后统一防抖重启生效（宿主对 home 层写入的活体应用是竞态的，boot 应用才确定——
 * 见 afterAction 注释），以及对插件状态文件的 fs.watch 主动刷新（Windows 上
 * setContextMenu 存在时右键不触发 right-click 事件，右键钩子刷新不可用；页面内管理器
 * 与 dsh CLI 的外部写入靠 watch 反映）。
 */
export interface TrayPluginSectionOpts {
  dshHome: string
  logDir: string
  restartSidecar: () => void
  notify: (title: string, content: string) => void
  refreshTray: () => void
  /** 全部启用前先重置守卫（reEnableAll：删守卫行+清台账+重置安全模式闩锁/预算）。 */
  guardReEnableAll: () => void
  /** 恢复确认框里展示守卫最近一次移出该包的原因（无则缺省文案）。 */
  bundleRemoveReason: (name: string) => string | undefined
  log: (line: string) => void
}

/** win32 递归 watch 的全路径匹配表（相对 dshHome，POSIX 斜杠形态）。 */
const WATCHED_REL_PATHS = new Set(['cordis.patch.yml', 'profiles/web/cordis.patch.yml', 'profiles/web/package.json'])
/**
 * 其余平台的浅层 watch 目标（inotify 递归模拟要给子树每个目录建 watch，pnpm 的
 * node_modules 大树会撞 max_user_watches 上限，且 sessions 高频写入全走回调）：三个
 * 状态文件都是 dshHome 或 profiles/web 的直接子文件，两级浅表 + basename 过滤即等价。
 */
const SHALLOW_WATCH_TARGETS: { relDir: string; basenames: Set<string> }[] = [
  { relDir: '', basenames: new Set(['cordis.patch.yml']) },
  { relDir: 'profiles/web', basenames: new Set(['cordis.patch.yml', 'package.json']) },
]

const REFRESH_DEBOUNCE_MS = 500
const RESTART_DEBOUNCE_MS = 1_500
const WATCH_RETRY_MAX_MS = 30_000

export class TrayPluginSection {
  private watchers = new Map<string, FSWatcher>()
  private watchBackoffMs = 1_000
  private watchRetryTimer: NodeJS.Timeout | undefined
  private refreshTimer: NodeJS.Timeout | undefined
  private restartTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(private readonly opts: TrayPluginSectionOpts) {}

  /** 「插件管理」菜单项（每次现读清单）。读取失败不弹窗（防菜单构建循环），降级为提示行。 */
  build(): MenuItemConstructorOptions {
    try {
      const inventory = listManagedPlugins({ dshHome: this.opts.dshHome })
      return buildPluginSection(inventory, {
        onToggle: (bundle, enabled) => this.toggle(bundle, enabled),
        onDisableAll: () => { void this.disableAll() },
        onEnableAll: () => { void this.enableAll() },
        onRestore: (name) => { void this.restore(name) },
      })
    } catch (error) {
      this.opts.log(`[dsh-desktop] tray plugin inventory threw: ${String(error)}`)
      return { label: '插件管理', submenu: [{ label: '⚠ 插件状态读取失败，详见日志目录', enabled: false }, { type: 'separator' }, { label: '全部停用…', enabled: false }, { label: '全部启用…', enabled: false }] }
    }
  }

  start(): void {
    this.attachWatch()
  }

  dispose(): void {
    this.disposed = true
    if (this.watchRetryTimer !== undefined) clearTimeout(this.watchRetryTimer)
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }

  /**
   * 懒挂载 + 自愈：dshHome（首启）或 profiles/web 可能尚不存在，直接 watch 会 ENOENT；
   * 被监视目录被删/出错时 watcher 报错即死。失败走退避重试（按目录独立补挂），
   * refresh() 顺带补挂兜底。win32 一个递归句柄覆盖全树；其余平台浅层两级。
   */
  private attachWatch(): void {
    if (this.disposed) return
    if (process.platform === 'win32') {
      const dir = this.opts.dshHome
      if (this.watchers.has(dir)) return
      try {
        const watcher = watch(dir, { recursive: true }, (_event, filename) => {
          const rel = filename === undefined ? '' : String(filename).split('\\').join('/')
          if (WATCHED_REL_PATHS.has(rel)) this.scheduleRefresh()
        })
        this.adoptWatcher(dir, watcher)
      } catch (error) {
        this.opts.log(`[dsh-desktop] tray plugin watch attach failed: ${String(error)}`)
        this.scheduleWatchRetry()
      }
      return
    }
    for (const target of SHALLOW_WATCH_TARGETS) {
      const dir = target.relDir === '' ? this.opts.dshHome : join(this.opts.dshHome, ...target.relDir.split('/'))
      if (this.watchers.has(dir)) continue
      try {
        const watcher = watch(dir, (_event, filename) => {
          const base = String(filename ?? '').split('\\').join('/').split('/').pop()
          if (base !== undefined && target.basenames.has(base)) this.scheduleRefresh()
        })
        this.adoptWatcher(dir, watcher)
      } catch (error) {
        this.opts.log(`[dsh-desktop] tray plugin watch attach failed (${dir}): ${String(error)}`)
        this.scheduleWatchRetry()
      }
    }
  }

  private adoptWatcher(dir: string, watcher: FSWatcher): void {
    watcher.on('error', (error) => {
      this.opts.log(`[dsh-desktop] tray plugin watch error (${dir}): ${String(error)}`)
      watcher.close()
      if (this.watchers.get(dir) === watcher) this.watchers.delete(dir)
      this.scheduleRefresh()
      this.scheduleWatchRetry()
    })
    this.watchers.set(dir, watcher)
    this.watchBackoffMs = 1_000
  }

  private watchComplete(): boolean {
    if (process.platform === 'win32') return this.watchers.has(this.opts.dshHome)
    return SHALLOW_WATCH_TARGETS.every((target) =>
      this.watchers.has(target.relDir === '' ? this.opts.dshHome : join(this.opts.dshHome, ...target.relDir.split('/'))))
  }

  private scheduleWatchRetry(): void {
    if (this.disposed || this.watchComplete() || this.watchRetryTimer !== undefined) return
    const delay = this.watchBackoffMs
    this.watchBackoffMs = Math.min(this.watchBackoffMs * 2, WATCH_RETRY_MAX_MS)
    this.watchRetryTimer = setTimeout(() => {
      this.watchRetryTimer = undefined
      this.attachWatch()
    }, delay)
  }

  private scheduleRefresh(): void {
    if (this.disposed) return
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      this.attachWatch() // 补挂兜底：watcher 曾失败且退避未到时借这次刷新恢复
      this.opts.refreshTray()
    }, REFRESH_DEBOUNCE_MS)
  }

  private scheduleRestart(): void {
    if (this.disposed) return
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.opts.restartSidecar()
    }, RESTART_DEBOUNCE_MS)
  }

  private toggle(bundle: string, enabled: boolean): void {
    try {
      const { changed } = setPluginEnabled({ dshHome: this.opts.dshHome, bundle, enabled })
      this.afterAction(enabled ? `已启用插件 ${bundle}` : `已停用插件 ${bundle}`, changed.length > 0)
    } catch (error) {
      this.fail(enabled ? `启用 ${bundle}` : `停用 ${bundle}`, error)
    }
  }

  private async disableAll(): Promise<void> {
    try {
      if (!(await this.confirm({
        message: '全部停用插件',
        detail: '将停用全部已安装插件（相当于安全模式），用于排查插件引起的问题；系统组件不受影响。之后可随时从托盘恢复。',
        confirmLabel: '全部停用',
      }))) return
      const { written } = disableAllPlugins({ dshHome: this.opts.dshHome })
      this.opts.log(`[dsh-desktop] tray disable-all: ${written.length} entries`)
      this.afterAction(written.length > 0 ? `已停用 ${written.length} 个插件条目` : '没有需要停用的插件条目', written.length > 0)
    } catch (error) {
      this.fail('全部停用', error)
    }
  }

  private async enableAll(): Promise<void> {
    try {
      if (!(await this.confirm({
        message: '全部启用插件',
        detail: '将启用全部插件（含守卫自动隔离和页面内停用的），并清空隔离台账。若问题插件再次引发故障，守卫会自动重新隔离。',
        confirmLabel: '全部启用',
      }))) return
      // 先重置守卫（安全模式闩锁/隔离预算/台账）——否则下次无签名崩溃会走「环境问题」
      // 分支而不再尝试安全模式；再清全部停用行（守卫行/托盘行/页面内行）。
      this.opts.guardReEnableAll()
      const { removed } = enableAllPlugins({ dshHome: this.opts.dshHome })
      this.opts.log(`[dsh-desktop] tray enable-all: ${removed.length} rows`)
      this.afterAction(removed.length > 0 ? `已启用全部插件（清除 ${removed.length} 条停用行）` : '全部插件本已启用', removed.length > 0)
    } catch (error) {
      this.fail('全部启用', error)
    }
  }

  private async restore(name: string): Promise<void> {
    try {
      const reason = this.opts.bundleRemoveReason(name)
      if (!(await this.confirm({
        message: `恢复 ${name}`,
        detail: `将把 ${name} 重新加入启动清单，并立即重启 dsh 服务。${reason !== undefined ? `\n\n守卫移出记录：${reason}` : ''}\n\n若该插件包确实损坏，重启后守卫会再次将其移出（这是安全网）。`,
        confirmLabel: '恢复并重启',
      }))) return
      const { written } = restoreBundle({ dshHome: this.opts.dshHome, name })
      this.afterAction(written.length > 0 ? `已恢复 ${name} 加入启动清单` : `${name} 已在启动清单中`, written.length > 0)
    } catch (error) {
      this.fail(`恢复 ${name}`, error)
    }
  }

  /**
   * 动作后统一防抖重启生效（实测校准 2026-08-24）：宿主对 home 层写入的活体应用是
   * 竞态的（与 dsh 自身 boot 后写 home 层存在丢失更新窗口，时灵时不灵），而 boot 时
   * 应用是确定性的——逃生通道要确定性，所有插件动作一律重启；1.5s 防抖合并连续多选。
   * acted=false（陈旧菜单下的幂等空操作）时不重启、只提示，避免无谓打断会话。
   */
  private afterAction(summary: string, acted: boolean): void {
    this.opts.log(`[dsh-desktop] tray plugin action: ${summary}`)
    this.opts.refreshTray()
    if (!acted) {
      this.opts.notify('DSH 插件管理', summary)
      return
    }
    this.scheduleRestart()
    this.opts.notify('DSH 插件管理', `${summary}，正在重启服务…`)
  }

  private async confirm(opts: { message: string; detail: string; confirmLabel: string }): Promise<boolean> {
    const result = await dialog.showMessageBox({
      type: 'question',
      message: opts.message,
      detail: opts.detail,
      buttons: [opts.confirmLabel, '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }

  /** 失败一律原生错误对话框（成功气泡是 Windows-only 通道，失败不能依赖它）。 */
  private fail(context: string, error: unknown): void {
    const detail = String(error)
    this.opts.log(`[dsh-desktop] tray plugin action failed (${context}): ${detail}`)
    this.opts.refreshTray()
    void dialog.showMessageBox({
      type: 'error',
      message: `无法完成：${context}`,
      detail: `${detail}\n\n详情见日志目录：${this.opts.logDir}`,
      buttons: ['知道了'],
      noLink: true,
    }).catch(() => { /* 对话框自身失败只留痕（上面已 log） */ })
  }
}
