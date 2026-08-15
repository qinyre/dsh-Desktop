import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { app, ipcMain, shell } from 'electron'
import { buildSidecarEnv, resolveAppPaths } from './app-paths'
import { EventTap } from './events/event-tap'
import { SidecarLogger } from './sidecar/sidecar-logger'
import { SidecarManager } from './sidecar/sidecar-manager'
import { resolveRuntime, toUnpackedPath } from './sidecar/runtime-resolver'
import { PluginManager } from './plugins/plugin-manager'
import { TrayController } from './tray/tray-controller'
import { UpdaterController } from './updater/updater-controller'
import { WindowController } from './windows/window-controller'
import { isPluginsPageSender } from './windows/navigation-guard'

const require = createRequire(import.meta.url) // ESM/CJS 双格式安全（Bug 6 修复）
// pnpm@10.34.5 的 exports 墙只放行 "."（映射到 ./package.json）——'pnpm/package.json'
// 与 'pnpm/bin/pnpm.cjs' 子路径均被拒。锚点走主入口（即 package.json 的绝对路径）拼
// bin/pnpm.cjs；老版 pnpm（无 exports 墙）则回退直接子路径解析。
// 两条路径都必须过 toUnpackedPath：打包后解析出来的是 app.asar 内的路径，而 shim 跑的是
// ELECTRON_RUN_AS_NODE 纯 Node 子进程，读不了 asar（与 dsh 入口同款映射，终审 Critical #1）。
const resolvePnpmCli = (): string => {
  try {
    return toUnpackedPath(join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.cjs'))
  } catch {
    return toUnpackedPath(require.resolve('pnpm/bin/pnpm.cjs'))
  }
}

// Windows toast 通知必需：不设 AppUserModelId 的打包应用通知会静默不显示；
// 必须与 electron-builder.yml 的 appId 一致（Bug 3 修复）。
app.setAppUserModelId('com.dosket.desktop')

// dev 默认源码仓：desktop/ 的兄弟目录 deepseek-harness（可用 DESKTOP_DSH_REPO 覆盖）
const repoRoot = process.env.DESKTOP_DSH_REPO ?? join(app.getAppPath(), '..', 'deepseek-harness')

let sidecar: SidecarManager | undefined
let windows: WindowController | undefined

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => { windows?.focus() })
  void app.whenReady().then(() => {
    const paths = resolveAppPaths({ packaged: app.isPackaged, env: process.env, userDataDir: app.getPath('userData'), repoRoot })
    const logger = new SidecarLogger(paths.logDir)
    // electron-vite dev 下渲染页来自 dev server、out/renderer 可能过期：优先用 ELECTRON_RENDERER_URL；
    // preload 两种模式都由 electron-vite 构建到 out/preload，../preload/index.js 通用。
    const rendererUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL !== undefined ? process.env.ELECTRON_RENDERER_URL : undefined
    const statusPagePath = rendererUrl !== undefined
      ? new URL('status/index.html', rendererUrl).href
      : join(__dirname, '../renderer/status/index.html')
    const pluginsPagePath = rendererUrl !== undefined
      ? new URL('plugins/index.html', rendererUrl).href
      : join(__dirname, '../renderer/plugins/index.html')
    windows = new WindowController({
      getState: () => sidecar?.state ?? 'idle',
      onRetry: () => { sidecar?.retry() },
      logDir: paths.logDir,
      preloadPath: join(__dirname, '../preload/index.js'),
      statusPagePath,
      pluginsPagePath,
      stateFile: join(paths.userDataDir, 'window-state.json'),
    })
    windows.createMainWindow()
    // 托盘（设计书 §5）：关闭=隐藏到托盘（首次隐藏弹一次气泡），退出走托盘菜单（sidecar 一并结束）。
    // dev 下 __dirname=out/main，../../resources 解析到 desktop/resources/icon.png。
    const tray = new TrayController({
      iconPath: join(__dirname, '../../resources/icon.png'),
      logDir: paths.logDir,
      onShow: () => { windows?.focus() },
      onPlugins: () => { windows?.openPluginDialog() },
      onQuit: () => { app.quit() },
    })
    if (windows.mainWindow !== undefined) tray.attach(windows.mainWindow)
    ipcMain.on('dosket:retry', () => sidecar?.retry())
    ipcMain.on('dosket:open-logs', () => { void shell.openPath(paths.logDir) })
    sidecar = new SidecarManager({
      runtime: () => resolveRuntime({ mode: paths.mode, execPath: process.execPath, repoRoot: paths.repoRoot, dshArgs: ['web', '--port', '0', '--host', '127.0.0.1'] }),
      env: buildSidecarEnv(paths, process.env),
      logger,
    })
    sidecar.on('ready', (port) => { windows?.loadDsh(port) })
    sidecar.on('statechange', (state) => {
      if (state === 'spawning' || state === 'crashed') windows?.showStatus('launching')
      if (state === 'failed') windows?.showStatus('failed', `详情见日志：${join(paths.logDir, 'sidecar.log')}`)
    })
    // 插件管理（设计书 §7）：dsh plugin 的宿主进程 + IPC 通道；输出逐行推给对话框。
    const pluginManager = new PluginManager({
      mode: paths.mode, execPath: process.execPath, repoRoot,
      dshHome: paths.dshHome, sidecarEnv: buildSidecarEnv(paths, process.env),
      shimDir: join(paths.userDataDir, 'bin'),
      resolvePnpmCli,
      onOutput: (line) => { windows?.pluginDialog?.webContents.send('dosket:plugins-output', line) },
      restartSidecar: () => { void sidecar?.restart() }, // ready 态的重启生效必须走 restart()，retry() 是 no-op（Bug 1 修复）
    })
    // 插件通道门禁（终审 Important #4；设计书 §7"安装=对话框明示同意"、§9）：主窗口与
    // 插件对话框共用一份 preload，dsh 页（含第三方 /plugins/<id>/client.js）同样拿得到
    // window.dosket.plugins——三个插件通道只接受插件页自身的 sender；dosket:retry /
    // dosket:open-logs 是状态页/托盘级关注点，保持开放。handle 通道抛错 → 渲染端 invoke
    // 拒绝；on 通道静默忽略。
    const assertPluginsPageSender = (url: string): void => {
      if (!isPluginsPageSender(url)) throw new Error(`plugin channel denied for sender: ${url}`)
    }
    ipcMain.handle('dosket:plugins:list', (event) => {
      assertPluginsPageSender(event.senderFrame?.url ?? '')
      return pluginManager.listInstalled()
    })
    ipcMain.handle('dosket:plugins:run', (event, args: unknown) => {
      assertPluginsPageSender(event.senderFrame?.url ?? '')
      return pluginManager.run(Array.isArray(args) ? args.map(String) : [])
    })
    ipcMain.on('dosket:restart-sidecar', (event) => {
      if (!isPluginsPageSender(event.senderFrame?.url ?? '')) return
      void sidecar?.restart()
    })

    // 通知水龙头（设计书 §6）：挂在 sidecar 生命周期上，ready 才连双下行 WS。
    // 闭包里 windows（let）不可窄化，取 mainWindow 需 ?.；whenReady 只 resolve 一次，
    // before-quit 监听不会重复注册（与下方 sidecar 的 before-quit 互不影响）。
    const eventTap = new EventTap({ getMainWindow: () => windows?.mainWindow })
    eventTap.attach(sidecar)
    app.on('before-quit', () => eventTap.close())

    // 自动更新（设计书 §8）：仅打包启用；无 feedUrl（dev/未配置）时 start() 静默跳过。
    if (app.isPackaged) {
      new UpdaterController({
        feedUrl: process.env.DOSKET_FEED_URL, // GitHub Releases 泛化地址；发布时写入实际 repo
        dshHome: paths.dshHome ?? '',
        backupRoot: join(paths.userDataDir, 'backups'),
      }).start()
    }

    sidecar.start()
  })
  // before-quit 同步生命周期里 `void stop()` 即可——Windows 硬杀即时完成；POSIX 分支的
  // 2s 宽限由 killSidecar 内部处理，Electron 退出不等 promise 是可接受的已知取舍（设计书 §4）。
  app.on('before-quit', () => { void sidecar?.stop() })
}
