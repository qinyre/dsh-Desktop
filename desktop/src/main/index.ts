import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { app, dialog, ipcMain, Menu, shell } from 'electron'
import { buildSidecarEnv, resolveAppPaths } from './app-paths'
import { EventTap } from './events/event-tap'
import { PluginGuard } from './plugins/plugin-guard'
import { showGuardReport } from './plugins/guard-report'
import { PluginRuntimeMonitor } from './plugins/guard-runtime'
import { auditProfileBundles, BundleBrickHealer } from './sidecar/profile-heal'
import { repairSkinsBrick, skinBrickDetected } from './sidecar/skin-selfheal'
import { SidecarLogger } from './sidecar/sidecar-logger'
import { SidecarManager } from './sidecar/sidecar-manager'
import { resolveRuntime, toUnpackedPath } from './sidecar/runtime-resolver'
import { ensurePnpmShim } from './plugins/pnpm-shim'
import { applyMarketConfig, atlasSeeded, ATLAS_SPEC, capabilitiesSeeded, CAPABILITIES_SPEC, DSHMARKET_SPEC, INSTALLER_SPEC, installerSeeded, marketSeeded, seedBundle, seedPendingPlugins } from './plugins/market-seed'
import { TrayController } from './tray/tray-controller'
import { TrayPluginSection } from './tray/tray-plugin-section'
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
// 插件守卫（plugin-guard.ts）：托盘回调引用它，声明必须先于 TrayController 构造。
let guard: PluginGuard | undefined
// ready 弹窗轮次号：每次 ready 递增，旧轮弹窗闭包据此失效（防 restart 循环双弹）。
let readyGeneration = 0

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
    // 客户端插件树 boot 失败的处置函数（需 guard/sidecar/tray 就绪后才定义，先占位）：
    // WindowController 的 console 转发在窗口创建时接线，实际逻辑在 sidecar 起来后赋值。
    let onRendererConsole: (text: string) => void = () => {}
    windows = new WindowController({
      getState: () => sidecar?.state ?? 'idle',
      onRetry: () => { sidecar?.retry() },
      logDir: paths.logDir,
      preloadPath: join(__dirname, '../preload/index.js'),
      statusPagePath,
      stateFile: join(paths.userDataDir, 'window-state.json'),
      onConsoleMessage: (text) => onRendererConsole(text),
    })
    const win = windows.createMainWindow()
    if (!app.isPackaged) win.webContents.openDevTools({ mode: 'detach' })
    // 状态页活动文本：拉（页面加载后取当前值，覆盖加载前的推送窗口）+ 推（后续变化）。
    ipcMain.handle('dsh:get-activity', () => windows?.getActivity() ?? '')
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
    // 插件日常管理在 Web UI 内的 dshmarket（设置页直达，无 URL 路由可深链）；托盘「插件管理」
    // 是页面打不开时的架构级逃生通道（逐插件启停/手动安全模式/恢复移出清单），不依赖页面与
    // sidecar 存活。「重启服务」承接市场的待重启提示（market 自重启已通过配置关闭，重启必须走
    // sidecar.restart 保持监督）。
    // dev 下 __dirname=out/main，../../resources 解析到 desktop/resources/icon.png。
    // updater 声明在托盘之前：「检查更新」菜单项回调引用它，而构造在下方 isPackaged 分支。
    let trayPlugins: TrayPluginSection | undefined
    let updater: UpdaterController | undefined
    const tray = new TrayController({
      iconPath: join(__dirname, '../../resources/icon.png'),
      logDir: paths.logDir,
      onShow: () => { windows?.focus() },
      onRestart: () => { void sidecar?.restart() },
      onCheckUpdates: () => { void updater?.checkNow() },
      pluginSection: paths.dshHome === undefined ? undefined : () => trayPlugins?.build(),
      onGuardReport: () => {
        const g = guard
        if (g === undefined) return
        const findings = g.findings()
        if (findings.length === 0) {
          void dialog.showMessageBox({ type: 'info', message: '当前没有已隔离的插件。', buttons: ['知道了'] })
          return
        }
        void showGuardReport({
          win: windows?.mainWindow,
          findings,
          onOpenLogs: () => { void shell.openPath(paths.logDir) },
          onReenable: () => { g.reEnableAll(); void sidecar?.restart() },
        }).then(() => g.markReported())
      },
      onQuit: () => { app.quit() },
    })
    if (windows.mainWindow !== undefined) tray.attach(windows.mainWindow)
    // 托盘插件管理分区：watcher 首挂此刻大概率 ENOENT（profiles/web 由下方审计/预装创建），
    // 懒挂载+退避重试自行消化；guard/sidecar 均 let 先引用后赋值，点击时已就位。
    if (paths.dshHome !== undefined) {
      trayPlugins = new TrayPluginSection({
        dshHome: paths.dshHome,
        logDir: paths.logDir,
        restartSidecar: () => { void sidecar?.restart() },
        notify: (title, content) => { tray.notify(title, content) },
        refreshTray: () => { tray.refresh() },
        guardReEnableAll: () => { guard?.reEnableAll() },
        bundleRemoveReason: (name) => {
          const found = guard?.findings().find(f => f.bundle === name)
          return found?.reason
        },
        log: (line) => { logger.appendLine(`[dsh-desktop] ${line}`) },
      })
      trayPlugins.start()
      // attach() 先于本段构造，初始菜单里没有插件管理项——这里补一次重建（否则稳态
      // 健康启动下若无外部写文件，该段要等到下次状态变化才出现）。
      tray.refresh()
    }
    ipcMain.on('dsh:retry', () => sidecar?.retry())
    ipcMain.on('dsh:open-logs', () => { void shell.openPath(paths.logDir) })
    // Web UI 内插件（dsh-plugin-install 的「重启服务」按钮）请求重启：sidecar 受
    // 应用监督，重启必须经壳层（SidecarManager.restart），插件侧自重启会脱离监督。
    ipcMain.on('dsh:restart-sidecar', () => { void sidecar?.restart() })
    // dsh 页 preload 上报的标题栏底色（跟随其明暗主题）。
    ipcMain.on('dsh:titlebar-color', (_event, css) => {
      if (typeof css === 'string') windows?.setTitleBarColor(css)
    })
    // 启动前 bundle 目录审计（profile-heal.ts 头注释有完整事故事实）：UI 内插件
    // 更新会被运行中 sidecar 的 fs.watch 句柄以 EPERM 打断、掏空包目录，且运行期
    // 重装同样 EPERM——唯一可靠的修复窗口是此刻（sidecar 未起、句柄不存在）。
    // 按 profile 依赖规格重跑 add（实测幂等）；失败不阻断启动，loader 补丁会把
    // 缺件 bundle 降级为跳过 + 告警。健康时开销仅为一次清单读取 + 若干 exists。
    if (paths.dshHome !== undefined) {
      windows?.showActivity('正在检查插件完整性…')
      const repaired = await auditProfileBundles({
        readManifest: () => { try { return readFileSync(join(paths.dshHome!, 'profiles', 'web', 'package.json'), 'utf8') } catch { return null } },
        bundleIntact: (name) => existsSync(join(paths.dshHome!, 'profiles', 'web', 'node_modules', name, 'package.json')),
        repair: (_name, spec) => seedBundle({
          mode: paths.mode, execPath: process.execPath, repoRoot: paths.repoRoot,
          env: sidecarEnv, specs: [spec], onOutput: (line) => { logger.appendLine(line) },
        }),
        log: (line) => { logger.appendLine(`[dsh-desktop] ${line}`) },
      })
      if (repaired.length > 0) logger.appendLine(`[dsh-desktop] pre-boot bundle audit repaired: ${repaired.join(', ')}`)
    }
    // 预装四个自带插件（仅打包模式：dev 不动用户的真实 DSH_HOME）。经 dsh CLI 安装，
    // 首启时 profile 尚不存在也成立（CLI 自带初始化 + reconcile）；未就位的合并成
    // 一次 CLI 调用安装（seedPendingPlugins：批量失败回退逐个）。失败不阻断启动，
    // 下次再试。市场装好后关掉其脱管自重启（applyMarketConfig）。
    if (paths.dshHome !== undefined) {
      const profileDir = join(paths.dshHome, 'profiles', 'web')
      await seedPendingPlugins({
        steps: [
          {
            name: 'dshmarket', spec: DSHMARKET_SPEC, seeded: marketSeeded(paths.dshHome),
            onSeeded: () => {
              try {
                applyMarketConfig(profileDir)
              } catch (error) {
                // 覆盖写不进去只损失市场的自重启开关（重启仍走托盘/安装页按钮），不值得赔上启动链。
                logger.appendLine(`[dsh-desktop] market config override failed: ${String(error)}`)
              }
            },
          },
          { name: 'dsh-plugin-install', spec: INSTALLER_SPEC, seeded: installerSeeded(paths.dshHome) },
          { name: 'dsh-plugin-capabilities', spec: CAPABILITIES_SPEC, seeded: capabilitiesSeeded(paths.dshHome) },
          { name: 'dsh-plugin-atlas', spec: ATLAS_SPEC, seeded: atlasSeeded(paths.dshHome) },
        ],
        run: (specs) => seedBundle({
          mode: paths.mode, execPath: process.execPath, repoRoot: paths.repoRoot,
          env: sidecarEnv, specs, onOutput: (line) => { logger.appendLine(line) },
        }),
        log: (line) => { logger.appendLine(`[dsh-desktop] ${line}`) },
        onProgress: ({ phase, current, done, total }) => {
          windows?.showActivity(phase === 'batch' ? `正在预装插件：${current}` : `正在预装插件 (${done}/${total})：${current}`)
        },
      })
    }
    // 插件守卫启动前静态预检（在审计与预装之后、sidecar 未起的安全窗口）：识别重复
    // entry id / 补丁层损坏等问题并先行隔离，避免进入崩溃循环。失败绝不阻断启动。
    guard = paths.dshHome === undefined ? undefined : new PluginGuard({
      dshHome: paths.dshHome,
      // 文件缺失（静默死亡的 boot 可能一行输出都没有，logger 惰性建文件）或读取失败都按
      // 空日志计：崩溃后拿不到任何输出本身就是「无证据」，安全模式的连击必须走得通。
      readLog: () => { try { return readFileSync(logger.filePath, 'utf8') } catch { return '' } },
      log: (line) => { logger.appendLine(`[dsh-desktop] ${line}`) },
      // 运行期新隔离的即时通知（ready 态才气泡；boot 态发现留给 ready 弹窗）。
      // 气泡即视为已告知：markReported 清 unreported，防下次 ready 对同条再弹一次。
      // 守卫写了隔离行 → 托盘插件管理菜单的状态需要重建。
      onNewFindings: (added) => {
        if (sidecar?.state !== 'ready') return
        tray.notify('DSH 插件守卫', `已自动处理 ${added.length} 个插件问题（${added.map(f => f.name ?? f.bundle ?? f.id ?? f.key).slice(0, 3).join('、')}），详情见托盘「插件隔离报告」。`)
        guard?.markReported()
        tray.refresh()
      },
    })
    if (guard !== undefined) {
      windows?.showActivity('正在检查插件安全状态…')
      guard.preBoot()
    }
    // 运行期插件健康轮询（boot 成功后经 pluginInventory 网关读 fiber 状态）：FAILED 即时
    // 写隔离行（home 层被 sidecar live watch，实时生效），PENDING 仅记账。start 幂等，
    // 每次 ready 重挂；crashed/failed/退出即停。onTick 挂 ready 态日志巡检（patrol）：
    // live-apply 失败不产生 crash 事件，只留 sidecar.log——巡检在 finally 语义下必跑，
    // pluginInventory 端点失明时这是运行期守卫仅存通道。
    const runtimeMonitor = guard === undefined ? undefined : new PluginRuntimeMonitor({
      port: () => sidecar?.port,
      onInventory: (entries) => { if (guard !== undefined) guard.considerRuntime(entries) },
      onTick: () => { runHealer('guard patrol', () => guard?.patrol()) },
      onError: (error) => { logger.appendLine(`[dsh-desktop] plugin guard runtime poll failed: ${String(error)}`) },
    })
    sidecar = new SidecarManager({
      // rc.8 起 dsh web 在非 SSH 环境默认把就绪 URL 交给系统默认浏览器；桌面壳自带
      // 窗口，必须 --no-open，否则每次启动都会多弹一个浏览器标签（SSH 抑制条件在
      // 桌面场景永远不成立）。
      runtime: () => resolveRuntime({ mode: paths.mode, execPath: process.execPath, repoRoot: paths.repoRoot, dshArgs: ['web', '--no-open', '--port', '0', '--host', '127.0.0.1'] }),
      env: sidecarEnv,
      logger,
    })
    // 客户端恢复状态：ready（新 boot 周期）时重置——reload 预算按 boot 周期而非进程寿命。
    let clientReloads = 0
    let clientStuckReported = false
    sidecar.on('ready', (port) => {
      windows?.loadDsh(port)
      guard?.noteBootSuccess()
      runtimeMonitor?.start()
      // 巡检两轮确认窗口清零：轮转后 ready 的当前日志只含本轮干净 boot，从头扫窗口。
      guard?.patrolBegin()
      clientReloads = 0
      clientStuckReported = false
      // 本轮有新隔离时弹一次报告（等 dsh 页加载完成再弹，3s 兜底）。fired 拦掉
      // 「兜底 timer 已触发后 did-finish-load 才到」的双弹；轮次号拦掉 restart 循环里
      // 旧 ready 挂上的 stale 监听闭包（旧轮的弹窗不该盖过新轮）。
      const generation = ++readyGeneration
      const win = windows?.mainWindow
      let fired = false
      const showPending = (): void => {
        if (fired || generation !== readyGeneration) return
        fired = true
        const pending = guard?.onReady() ?? []
        if (pending.length === 0) return
        showGuardReport({
          win,
          findings: pending,
          onOpenLogs: () => { void shell.openPath(paths.logDir) },
          onReenable: () => { guard?.reEnableAll(); void sidecar?.restart() },
        }).then(() => guard?.markReported()).catch(() => { /* 弹窗被窗口销毁打断等：报告留台账，托盘可重开 */ })
      }
      if (win === undefined) { showPending(); return }
      const fallbackTimer = setTimeout(showPending, 3_000)
      win.webContents.once('did-finish-load', () => { clearTimeout(fallbackTimer); showPending() })
    })
    // 客户端插件树 boot 失败的恢复链（渲染器 console 遥测 → 按名隔离 → reload 重试）：
    // 客户端清单按页烘焙，隔离行经宿主 live watch 生效后必须重载页面才能重组合；宿主
    // watch 重组是秒级异步，reload 延迟 1.5s 且以「失败复现」驱动重试（每次 reload 的新
    // entry id 都不同，acted 与否不构成终态信号）。只动加载后短窗内的失败（boot 场景）；
    // 会话中段的客户端失败只报告不打断用户。重试上限 3 次，耗尽即弹隔离报告。
    onRendererConsole = (text: string): void => {
      const g = guard
      if (g === undefined) return
      const { relevant, resolvable } = g.considerClientConsole(text)
      if (!relevant) return
      const age = windows?.dshLoadAge()
      const inBootWindow = age !== undefined && age < 30_000
      if (resolvable && inBootWindow && clientReloads < 3) {
        clientReloads += 1
        logger.appendLine(`[dsh-desktop] client plugin boot failure detected; reload ${clientReloads}/3`)
        setTimeout(() => {
          if (sidecar?.state === 'ready' && windows?.reloadDshPage() !== true) {
            logger.appendLine('[dsh-desktop] client recovery reload skipped: dsh page not active')
          }
        }, 1_500)
        return
      }
      if (clientStuckReported) return
      clientStuckReported = true
      const pending = g.onReady()
      if (pending.length === 0) return
      logger.appendLine(`[dsh-desktop] client plugin failure not auto-recoverable (${resolvable ? 'retries exhausted' : 'host row unresolved'}); reporting`)
      void showGuardReport({
        win: windows?.mainWindow,
        findings: pending,
        onOpenLogs: () => { void shell.openPath(paths.logDir) },
        onReenable: () => { g.reEnableAll(); void sidecar?.restart() },
      }).then(() => g.markReported()).catch(() => { /* 弹窗被打断：报告留台账，托盘可重开 */ })
    }
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
        env: sidecarEnv, specs: [spec], onOutput: (line) => { logger.appendLine(line) },
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
      if (state === 'spawning') windows?.showActivity('正在启动 dsh 服务…')
      if (state === 'failed') windows?.showStatus('failed', `详情见日志：${join(paths.logDir, 'sidecar.log')}`)
      if (state === 'crashed' || state === 'failed') {
        runtimeMonitor?.stop()
        runHealer('skin heal', () => healSkins())
        // terminal：管理器已放弃重启，对修复失败过的包再给一次机会。
        runHealer('bundle heal', () => bundleHealer?.consider({ terminal: state === 'failed' }))
        // 插件守卫排在两个自愈器之后（读的是它们修复后的最新状态）：诊断崩溃日志 →
        // 隔离问题插件。有新隔离且已落 failed 终态时显式拉起（restart 清零重启预算）；
        // crashed 则由管理器自带的退避重启接管（隔离是同步 fs 操作，必然赶在 respawn 前）。
        runHealer('plugin guard', () => {
          if (guard === undefined) return
          const { quarantinedNew } = guard.considerCrash({ terminal: state === 'failed' })
          if (quarantinedNew && sidecar?.state === 'failed') void sidecar.restart()
        })
      }
    })
    // 通知水龙头（设计书 §6）：挂在 sidecar 生命周期上，ready 才连双下行 WS。
    // 闭包里 windows（let）不可窄化，取 mainWindow 需 ?.；whenReady 只 resolve 一次，
    // before-quit 监听不会重复注册（与下方 sidecar 的 before-quit 互不影响）。
    const eventTap = new EventTap({ getMainWindow: () => windows?.mainWindow })
    eventTap.attach(sidecar)
    app.on('before-quit', () => { eventTap.close(); runtimeMonitor?.stop(); trayPlugins?.dispose() })

    // 自动更新（设计书 §8）：默认检查本仓库的 GitHub Releases（v0.1.0 起资产带 latest.yml），
    // DSH_DESKTOP_FEED_URL 可覆盖为任意 generic feed（本地测试/未来迁移）；仅打包启用。
    if (app.isPackaged) {
      updater = new UpdaterController({
        feed: process.env.DSH_DESKTOP_FEED_URL ?? { provider: 'github', owner: 'qinyre', repo: 'dsh-Desktop' },
        dshHome: paths.dshHome ?? '',
        backupRoot: join(paths.userDataDir, 'backups'),
      })
      updater.start()
    }

    sidecar.start()
  })
  // before-quit 同步生命周期里 `void stop()` 即可——Windows 硬杀即时完成；POSIX 分支的
  // 2s 宽限由 killSidecar 内部处理，Electron 退出不等 promise 是可接受的已知取舍（设计书 §4）。
  app.on('before-quit', () => { void sidecar?.stop() })
}
