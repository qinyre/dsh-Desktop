import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { TrayPluginSection } from './tray-plugin-section'

/**
 * watch 刷新链的最小真实验证：win32 递归与 posix 浅层两形态都必须把三个状态文件的
 * 变更折成 refreshTray（500ms 防抖）。electron 的 dialog 只在确认/失败路径使用，
 * 本测试不触碰（node 环境下 electron 模块解析为二进制路径占位，同样不触碰）。
 */
const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-traywatch-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

describe('TrayPluginSection watch（状态文件变更 → 防抖刷新托盘）', () => {
  it('refreshes the tray when any of the three state files changes', { timeout: 20_000 }, async () => {
    const dshHome = join(root, 'home')
    mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })
    const refreshTray = vi.fn()
    const section = new TrayPluginSection({
      dshHome,
      logDir: root,
      restartSidecar: () => {},
      notify: () => {},
      refreshTray,
      guardReEnableAll: () => {},
      bundleRemoveReason: () => undefined,
      log: () => {},
    })
    section.start()
    await sleep(300) // watcher 就位
    writeFileSync(join(dshHome, 'cordis.patch.yml'), 'entries: []\n')
    writeFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'entries: []\n')
    writeFileSync(join(dshHome, 'profiles', 'web', 'package.json'), '{}\n')
    await sleep(1_500) // 500ms 防抖 + inotify/ReadDirectoryChangesW 传播余量
    section.dispose()
    expect(refreshTray.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('missing profiles/web does not crash the section (lazy retry path)', { timeout: 20_000 }, async () => {
    const dshHome = join(root, 'home-empty') // 完全不存在：attach 走 ENOENT 退避
    const refreshTray = vi.fn()
    const section = new TrayPluginSection({
      dshHome,
      logDir: root,
      restartSidecar: () => {},
      notify: () => {},
      refreshTray,
      guardReEnableAll: () => {},
      bundleRemoveReason: () => undefined,
      log: () => {},
    })
    section.start()
    await sleep(200)
    section.dispose()
    expect(refreshTray).not.toHaveBeenCalled()
  })
})
