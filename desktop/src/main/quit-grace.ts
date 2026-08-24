/**
 * 退出宽限（POSIX 主场景）：killSidecar 的 SIGTERM→2s→SIGKILL 宽限需要被等到，
 * 否则主进程先走、SIGKILL 定时器随进程消亡，可能留下孤儿 sidecar。
 *
 * will-quit 拦截（preventDefault）→ await stop() → app.exit(0) 收尾：
 * - app.exit 不再触发 before-quit/will-quit，无循环；门闩拦掉 app.quit 二次进入。
 * - 与 electron-updater 的 quitAndInstall 兼容：安装动作（spawn 安装器/AppImage 就地
 *   替换）发生在 setImmediate(app.quit) 之前，不依赖 after-quit（且本项目
 *   autoInstallOnAppQuit=false，退出路径不会有补装）。
 * - win32 的硬杀即时完成，等待只是几十 ms 级保险。
 */
export interface QuitGraceApp {
  on(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown
}

export function installQuitGrace(
  appLike: QuitGraceApp,
  opts: { stop: () => Promise<void> | void | undefined; exit: (code: number) => void; timeoutMs?: number; log?: (line: string) => void },
): void {
  const timeoutMs = opts.timeoutMs ?? 3_000
  let quitting = false
  appLike.on('will-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    const bail = setTimeout(() => opts.exit(0), timeoutMs)
    void Promise.resolve(opts.stop())
      .catch((error) => opts.log?.(`[dsh-desktop] sidecar stop threw during quit: ${String(error)}`))
      .finally(() => { clearTimeout(bail); opts.exit(0) })
  })
}
