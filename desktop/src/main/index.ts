import { join } from 'node:path'
import { app } from 'electron'
import { buildSidecarEnv, resolveAppPaths } from './app-paths'
import { SidecarLogger } from './sidecar/sidecar-logger'
import { SidecarManager } from './sidecar/sidecar-manager'
import { resolveRuntime } from './sidecar/runtime-resolver'

// dev 默认源码仓：desktop/ 的兄弟目录 deepseek-harness（可用 DESKTOP_DSH_REPO 覆盖）
const repoRoot = process.env.DESKTOP_DSH_REPO ?? join(app.getAppPath(), '..', 'deepseek-harness')

let sidecar: SidecarManager | undefined

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => { /* Task 8 聚焦已有窗口 */ })
  void app.whenReady().then(() => {
    const paths = resolveAppPaths({ packaged: app.isPackaged, env: process.env, userDataDir: app.getPath('userData'), repoRoot })
    const logger = new SidecarLogger(paths.logDir)
    sidecar = new SidecarManager({
      runtime: () => resolveRuntime({ mode: paths.mode, execPath: process.execPath, repoRoot: paths.repoRoot, dshArgs: ['web', '--port', '0', '--host', '127.0.0.1'] }),
      env: buildSidecarEnv(paths, process.env),
      logger,
    })
    sidecar.on('ready', (port) => { console.log(`sidecar ready on ${port}`) }) // Task 8 换成 WindowController.loadDsh
    sidecar.on('statechange', (state) => { if (state === 'failed') console.error('sidecar failed — see', logger.filePath) })
    sidecar.start()
  })
  // before-quit 同步生命周期里 `void stop()` 即可——Windows 硬杀即时完成；POSIX 分支的
  // 2s 宽限由 killSidecar 内部处理，Electron 退出不等 promise 是可接受的已知取舍（设计书 §4）。
  app.on('before-quit', () => { void sidecar?.stop() })
}
