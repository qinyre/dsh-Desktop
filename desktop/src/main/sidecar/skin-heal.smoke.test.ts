import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SidecarLogger } from './sidecar-logger'
import { SidecarManager } from './sidecar-manager'
import { resolveRuntime } from './runtime-resolver'
import { repairSkinsBrick, skinBrickDetected } from './skin-selfheal'

// 自愈端到端（gated）：构造真实的「启用中卸载」砖状态——根 patch 写入皮肤中心
// 格式的 managed 块（指向不存在的包）——用真实 SidecarManager 启动源码 dsh，
// 复刻 index.ts 的接线，断言：崩溃后自愈触发、patch 去块留备份、退避重启达到
// ready。与 integration.smoke.test.ts 同前置（harness 就位、node ≥22.19）。
const repoRoot = join(__dirname, '..', '..', '..', '..', 'deepseek-harness')
const guard = existsSync(join(repoRoot, 'apps', 'cli', 'src', 'bin.ts'))
const [smokeNodeMajor, smokeNodeMinor] = process.version.slice(1).split('.').map(Number)
const nodeOk = (smokeNodeMajor === 22 && smokeNodeMinor >= 19) || smokeNodeMajor >= 24

describe.skipIf(!guard || !nodeOk)('skin self-heal smoke', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-skinheal-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('recovers a skinned-brick home to readiness without manual repair', { timeout: 180_000 }, async () => {
    const home = join(root, 'dsh-home')
    const profile = join(home, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    const rootPatch = join(home, 'cordis.patch.yml')
    writeFileSync(rootPatch, [
      '# --- dsh-skin managed (auto-generated; do not edit) ---',
      '- id: ui-skin-qq98',
      '  disabled: true',
      '- insert:',
      "    - id: ui-skin-blue-fantasy",
      "      name: '@linxin666/dsh-client-ui-skin-blue-fantasy'",
      '# --- end dsh-skin managed ---',
      '',
    ].join('\r\n'), 'utf8')
    let linkCreated = false
    const scopeDir = join(profile, 'node_modules', '@linxin666')
    mkdirSync(scopeDir, { recursive: true })
    try {
      symlinkSync(join(home, 'gone', 'skins', 'blue-fantasy'), join(scopeDir, 'dsh-client-ui-skin-blue-fantasy'), 'dir')
      linkCreated = true
    } catch {
      // symlink 权限缺失的环境：仅验证 patch 自愈路径。
    }

    const logDir = join(root, 'logs')
    const logger = new SidecarLogger(logDir)
    const mgr = new SidecarManager({
      runtime: () => resolveRuntime({
        mode: 'source',
        execPath: process.execPath,
        repoRoot,
        dshArgs: ['web', '--port', '0', '--host', '127.0.0.1'],
      }),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_DESKTOP: '' },
      logger,
      readyTimeoutMs: 90_000,
    })

    // index.ts 的同款接线（ healed 一次性守卫 + failed 显式 restart）。
    let skinHealed = false
    let sawCrashed = false
    mgr.on('statechange', (state) => {
      if (state === 'crashed' || state === 'failed') {
        sawCrashed = sawCrashed || state === 'crashed'
        if (skinHealed) return
        let logText = ''
        try { logText = readFileSync(logger.filePath, 'utf8') } catch { return }
        if (!skinBrickDetected(logText)) return
        const actions = repairSkinsBrick({ dshHome: home })
        if (actions.length === 0) return
        skinHealed = true
        logger.appendLine(`[dsh-desktop] skin-plugin leftover detected; repair: ${actions.join(' | ')}`)
        if (mgr.state === 'failed') void mgr.restart()
      }
    })

    const ready = new Promise<number>((resolve) => mgr.on('ready', resolve))
    mgr.start()
    const port = await ready
    expect(port).toBeGreaterThan(0)
    await mgr.stop()

    expect(sawCrashed).toBe(true)
    expect(skinHealed).toBe(true)
    expect(readFileSync(rootPatch, 'utf8')).not.toContain('ui-skin')
    const backups = readdirSync(home).filter((name) => name.startsWith('cordis.patch.yml.skinheal-'))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(home, backups[0]), 'utf8')).toContain('# --- dsh-skin managed')
    if (linkCreated) {
      expect(existsSync(scopeDir)).toBe(false)
    }
  })
})
