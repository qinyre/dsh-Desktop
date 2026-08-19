import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { app, ipcMain, Menu, shell } from 'electron'
import { buildSidecarEnv, resolveAppPaths } from './app-paths'
import { EventTap } from './events/event-tap'
import { BundleBrickHealer } from './sidecar/profile-heal'
import { repairSkinsBrick, skinBrickDetected } from './sidecar/skin-selfheal'
import { SidecarLogger } from './sidecar/sidecar-logger'
import { SidecarManager } from './sidecar/sidecar-manager'
import { resolveRuntime, toUnpackedPath } from './sidecar/runtime-resolver'
import { ensurePnpmShim } from './plugins/pnpm-shim'
import { applyMarketConfig, atlasSeeded, ATLAS_SPEC, capabilitiesSeeded, CAPABILITIES_SPEC, DSHMARKET_SPEC, INSTALLER_SPEC, installerSeeded, marketSeeded, seedAtlas, seedBundle, seedCapabilities, seedDshmarket, seedInstaller } from './plugins/market-seed'
import { TrayController } from './tray/tray-controller'
import { UpdaterController } from './updater/updater-controller'
import { WindowController } from './windows/window-controller'

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
app.setAppUserModelId('com.dshdesktop.app')

// 去掉 Electron 默认菜单栏（File/Edit/View/Window/Help）：壳应用用不到，dsh 页自带完整 UI。
// 附带效果：菜单角色承载的加速键（Ctrl+R/F12 等）失效，dev 的 devtools 入口在创建主窗口后补回。
Menu.setApplicationMenu(null)

// dev 默认源码仓：desktop/ 的兄弟目录 deepseek-harness（可用 DESKTOP_DSH_REPO 覆盖）
const repoRoot = process.env.DESKTOP_DSH_REPO ?? join(app.getAppPath(), '..', 'deepseek-harness')

let sidecar: SidecarManager | undefined
let windows: WindowController | undefined

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => { windows?.focus() })
  void app.whenReady().then(async () => {
    const paths = resolveAppPaths({ packaged: app.isPackaged, env: process.env, userDataDir: app.getPath('userData'), repoRoot })
    const logger = new SidecarLogger(paths.logDir)
    // electron-vite dev 下渲染页来自 dev server、out/renderer 可能过期：优先用 ELECTRON_RENDERER_URL；
    // preload 两种模式都由 electron-vite 构建到 out/preload，../preload/index.js 通用。
    const rendererUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL !== undefined ? process.env.ELECTRON_RENDERER_URL : undefined
    const statusPagePath = rendererUrl !== undefined
      ? new URL('status/index.html', rendererUrl).href
      : join(__dirname, '../renderer/status/index.html')
    windows = new WindowController({
      getState: () => sidecar?.state ?? 'idle',
      onRetry: () => { sidecar?.retry() },
      logDir: paths.logDir,
      preloadPath: join(__dirname, '../preload/index.js'),
      statusPagePath,
      stateFile: join(paths.userDataDir, 'window-state.json'),
    })
    const win = windows.createMainWindow()
    if (!app.isPackaged) win.webContents.openDevTools({ mode: 'detach' })
    // 零配置桥（设计书 §7 演进：第三方插件管理移交 dshmarket 插件）：shim 目录前置进
    // sidecar PATH——dsh CLI 与市场重调的 CLI 子进程都靠它在无 Node 机器上找到 pnpm。
    const shimDir = join(paths.userDataDir, 'bin')
    let sidecarEnv = buildSidecarEnv(paths, process.env)
    try {
      await ensurePnpmShim({ execPath: process.execPath, shimDir, resolvePnpmCli })
      sidecarEnv = buildSidecarEnv(paths, process.env, { shimDir })
    } catch (error) {
      logger.appendLine(`[dsh-desktop] pnpm shim unavailable (${String(error)}); plugin installs will need a system pnpm`)
    }
    // 托盘（设计书 §5）：关闭=隐藏到托盘（首次隐藏弹一次气泡），退出走托盘菜单（sidecar 一并结束）。
    // 插件管理已由 Web UI 内的 dshmarket 接管（设置页直达，无 URL 路由可深链，故不设托盘入口）；
    // 「重启服务」承接市场的待重启提示（market 自重启已通过配置关闭，重启必须走 sidecar.restart 保持监督）。
    // dev 下 __dirname=out/main，../../resources 解析到 desktop/resources/icon.png。
    const tray = new TrayController({
      iconPath: join(__dirname, '../../resources/icon.png'),
      logDir: paths.logDir,
      onShow: () => { windows?.focus() },
      onRestart: () => { void sidecar?.restart() },
      onQuit: () => { app.quit() },
    })
    if (windows.mainWindow !== undefined) tray.attach(windows.mainWindow)
    ipcMain.on('dsh:retry', () => sidecar?.retry())
    ipcMain.on('dsh:open-logs', () => { void shell.openPath(paths.logDir) })
    // Web UI 内插件（dsh-plugin-install 的「重启服务」按钮）请求重启：sidecar 受
    // 应用监督，重启必须经壳层（SidecarManager.restart），插件侧自重启会脱离监督。
    ipcMain.on('dsh:restart-sidecar', () => { void sidecar?.restart() })
    // dsh 页 preload 上报的标题栏底色（跟随其明暗主题）。
    ipcMain.on('dsh:titlebar-color', (_event, css) => {
      if (typeof css === 'string') windows?.setTitleBarColor(css)
    })
    // 预装插件市场（仅打包模式：dev 不动用户的真实 DSH_HOME）。经 dsh CLI 安装，首启时
    // profile 尚不存在也成立（CLI 自带初始化 + reconcile）；失败不阻断启动，下次再试。
    if (paths.dshHome !== undefined && !marketSeeded(paths.dshHome)) {
      logger.appendLine(`[dsh-desktop] seeding plugin market (${DSHMARKET_SPEC})`)
      const code = await seedDshmarket({
        mode: paths.mode, execPath: process.execPath, repoRoot: paths.repoRoot,
        env: sidecarEnv, onOutput: (line) => { logger.appendLine(line) },
      })
      if (code === 0) {
        applyMarketConfig(join(paths.dshHome, 'profiles', 'web'))
      } else {
        logger.appendLine(`[dsh-desktop] market seed failed (exit ${code}); retrying next launch`)
      }
    }
    // 预装插件安装器（设置页「安装」Tab，qinyre/dsh-plugin-install）。无需配置覆盖：
    // 桌面模式下其重启按钮经 dsh:restart-sidecar IPC 交回壳层，没有脱管自重启。
    if (paths.dshHome !== undefined && !installerSeeded(paths.dshHome)) {
      logger.appendLine(`[dsh-desktop] seeding plugin installer (${INSTALLER_SPEC})`)
      const code = await seedInstaller({
        mode: paths.mode, execPath: process.execPath, repoRoot: paths.repoRoot,
        env: sidecarEnv, onOutput: (line) => { logger.appendLine(line) },
      })
      if (code !== 0) {
        logger.appendLine(`[dsh-desktop] installer seed failed (exit ${code}); retrying next launch`)
      }
    }
    // 预装能力管理插件（设置页一级分区「技能与 MCP」，qinyre/dsh-plugin-capabilities）。
    // 同样无需配置覆盖：待重启横幅经 dsh:restart-sidecar IPC 交回壳层。
    if (paths.dshHome !== undefined && !capabilitiesSeeded(paths.dshHome)) {
      logger.appendLine(`[dsh-desktop] seeding capabilities plugin (${CAPABILITIES_SPEC})`)
      const code = await seedCapabilities({
        mode: paths.mode, execPath: process.execPath, repoRoot: paths.repoRoot,
        env: sidecarEnv, onOutput: (line) => { logger.appendLine(line) },
      })
      if (code !== 0) {
        logger.appendLine(`[dsh-desktop] capabilities seed failed (exit ${code}); retrying next launch`)
      }
    }
    // 预装归档与刻度尺插件（qinyre/dsh-plugin-atlas，「已归档会话」面板 + 对话刻度尺）。
    // 纯路由与 UI 扩展，无重启路径，无需配置覆盖。
    if (paths.dshHome !== undefined && !atlasSeeded(paths.dshHome)) {
      logger.appendLine(`[dsh-desktop] seeding atlas plugin (${ATLAS_SPEC})`)
      const code = await seedAtlas({
        mode: paths.mode, execPath: process.execPath, repoRoot: paths.repoRoot,
        env: sidecarEnv, onOutput: (line) => { logger.appendLine(line) },
      })
      if (code !== 0) {
        logger.appendLine(`[dsh-desktop] atlas seed failed (exit ${code}); retrying next launch`)
      }
    }
    sidecar = new SidecarManager({
      runtime: () => resolveRuntime({ mode: paths.mode, execPath: process.execPath, repoRoot: paths.repoRoot, dshArgs: ['web', '--port', '0', '--host', '127.0.0.1'] }),
      env: sidecarEnv,
      logger,
    })
    sidecar.on('ready', (port) => { windows?.loadDsh(port) })
    // 皮肤卸载残留自愈（skin-selfheal.ts 头注释有完整上游事实）：启用中卸载皮肤包
    // 会留下 managed 块 + 悬空链接，下次启动 loader 导入失败、整树拒绝。特征唯一、
    // 修复确定，crashed 时同步修完，管理器自带的退避重启（1s 起）拉起的就是干净状态，
    // 用户只感知一次稍慢的启动。每进程最多自愈一次：修复不生效时不得无限循环。
    let skinHealed = false
    const healSkins = (): void => {
      if (skinHealed || paths.dshHome === undefined) return
      let logText = ''
      try { logText = readFileSync(logger.filePath, 'utf8') } catch { return }
      if (!skinBrickDetected(logText)) return
      const actions = repairSkinsBrick({ dshHome: paths.dshHome })
      if (actions.length === 0) return
      skinHealed = true
      logger.appendLine(`[dsh-desktop] skin-plugin leftover detected; repair: ${actions.join(' | ')}`)
      // failed 是终态（重启预算已耗尽），修复后必须显式拉起；crashed 则由管理器
      // 自带的退避重启接管（1s 起，修复是同步 fs 操作，必然赶在 respawn 前）。
      if (sidecar?.state === 'failed') void sidecar.restart()
    }
    // 断链 profile bundle 自愈（profile-heal.ts 头注释有完整事故事实）：插件更新
    // 中途被打断会留下「bundles 声明了包、node_modules 目录为空」的状态，启动期
    // 直接抛错进崩溃循环，插件层无从插手。修复 = 经 seedBundle 路径重跑一次
    // `dsh plugin add <name>@<钉住版本>`（实测幂等）。修复是异步的（秒级），
    // 自愈器内部单飞 + 限额；崩溃循环耗尽预算落 failed 后由 onRepaired 显式拉起。
    const bundleHealer = paths.dshHome === undefined ? undefined : new BundleBrickHealer({
      readLog: () => { try { return readFileSync(logger.filePath, 'utf8') } catch { return null } },
      readManifest: () => { try { return readFileSync(join(paths.dshHome!, 'profiles', 'web', 'package.json'), 'utf8') } catch { return null } },
      repair: (_name, spec) => seedBundle({
        mode: paths.mode, execPath: process.execPath, repoRoot: paths.repoRoot,
        env: sidecarEnv, spec, onOutput: (line) => { logger.appendLine(line) },
      }),
      log: (line) => { logger.appendLine(`[dsh-desktop] ${line}`) },
      onRepaired: () => { if (sidecar?.state === 'failed') void sidecar.restart() },
    })
    // 两个自愈互不连坐：任一抛错（含日志写入失败）只留痕，不得阻断另一个
    // 或打断 statechange 处理（2026-08-19 实机断链事故里自愈零痕迹的教训）。
    const runHealer = (label: string, run: () => void): void => {
      try {
        run()
      } catch (error) {
        try { logger.appendLine(`[dsh-desktop] ${label} threw: ${String(error)}`) } catch { /* 日志本身不可用 */ }
      }
    }
    sidecar.on('statechange', (state) => {
      if (state === 'spawning' || state === 'crashed') windows?.showStatus('launching')
      if (state === 'failed') windows?.showStatus('failed', `详情见日志：${join(paths.logDir, 'sidecar.log')}`)
      if (state === 'crashed' || state === 'failed') {
        runHealer('skin heal', () => healSkins())
        // terminal：管理器已放弃重启，对修复失败过的包再给一次机会。
        runHealer('bundle heal', () => bundleHealer?.consider({ terminal: state === 'failed' }))
      }
    })
    // 通知水龙头（设计书 §6）：挂在 sidecar 生命周期上，ready 才连双下行 WS。
    // 闭包里 windows（let）不可窄化，取 mainWindow 需 ?.；whenReady 只 resolve 一次，
    // before-quit 监听不会重复注册（与下方 sidecar 的 before-quit 互不影响）。
    const eventTap = new EventTap({ getMainWindow: () => windows?.mainWindow })
    eventTap.attach(sidecar)
    app.on('before-quit', () => eventTap.close())

    // 自动更新（设计书 §8）：默认检查本仓库的 GitHub Releases（v0.1.0 起资产带 latest.yml），
    // DSH_DESKTOP_FEED_URL 可覆盖为任意 generic feed（本地测试/未来迁移）；仅打包启用。
    if (app.isPackaged) {
      new UpdaterController({
        feed: process.env.DSH_DESKTOP_FEED_URL ?? { provider: 'github', owner: 'qinyre', repo: 'dsh-Desktop' },
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
