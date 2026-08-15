import { join } from 'node:path'
import { app, ipcMain, shell } from 'electron'
import { buildSidecarEnv, resolveAppPaths } from './app-paths'
import { EventTap } from './events/event-tap'
import { SidecarLogger } from './sidecar/sidecar-logger'
import { SidecarManager } from './sidecar/sidecar-manager'
import { resolveRuntime } from './sidecar/runtime-resolver'
import { WindowController } from './windows/window-controller'

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
    const statusPagePath = !app.isPackaged && process.env.ELECTRON_RENDERER_URL !== undefined
      ? new URL('status/index.html', process.env.ELECTRON_RENDERER_URL).href
      : join(__dirname, '../renderer/status/index.html')
    windows = new WindowController({
      getState: () => sidecar?.state ?? 'idle',
      onRetry: () => { sidecar?.retry() },
      logDir: paths.logDir,
      preloadPath: join(__dirname, '../preload/index.js'),
      statusPagePath,
      stateFile: join(paths.userDataDir, 'window-state.json'),
    })
    windows.createMainWindow()
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
    // 通知水龙头（设计书 §6）：挂在 sidecar 生命周期上，ready 才连双下行 WS。
    // 闭包里 windows（let）不可窄化，取 mainWindow 需 ?.；whenReady 只 resolve 一次，
    // before-quit 监听不会重复注册（与下方 sidecar 的 before-quit 互不影响）。
    const eventTap = new EventTap({ getMainWindow: () => windows?.mainWindow })
    eventTap.attach(sidecar)
    app.on('before-quit', () => eventTap.close())

    sidecar.start()
  })
  // before-quit 同步生命周期里 `void stop()` 即可——Windows 硬杀即时完成；POSIX 分支的
  // 2s 宽限由 killSidecar 内部处理，Electron 退出不等 promise 是可接受的已知取舍（设计书 §4）。
  app.on('before-quit', () => { void sidecar?.stop() })
}
