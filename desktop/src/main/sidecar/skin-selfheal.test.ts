import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { removeDanglingSkinLinks, repairSkinsBrick, skinBrickDetected, stripSkinManagedBlock } from './skin-selfheal'

// 用户实机两次采到的 managed 块形状（换行 \r\n）：互斥 disabled 行 + 启用皮肤
// 的 insert 行。空行与前后内容都按真实文件构造。
const SAMPLE_BLOCK = [
  '# --- dsh-skin managed (auto-generated; do not edit) ---',
  '- id: ui-skin-qq98',
  '  disabled: true',
  '- insert:',
  "    - id: ui-skin-blue-fantasy",
  "      name: '@linxin666/dsh-client-ui-skin-blue-fantasy'",
  '# --- end dsh-skin managed ---',
].join('\r\n')

const SIGNATURE_LINE = 'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry ui-skin-blue-fantasy (@linxin666/dsh-client-ui-skin-blue-fantasy): Cannot find package'

describe('skinBrickDetected', () => {
  it('matches the loader fatal line', () => {
    expect(skinBrickDetected(SIGNATURE_LINE)).toBe(true)
  })
  it('ignores unrelated failures and the GBK mojibake cmd lines', () => {
    expect(skinBrickDetected("'cmd' 不是内部或外部命令")).toBe(false)
    expect(skinBrickDetected('Error: dsh: plugin tree failed to load: something else')).toBe(false)
    expect(skinBrickDetected('')).toBe(false)
  })
})

describe('stripSkinManagedBlock', () => {
  it('removes the whole managed block, keeps surrounding user content', () => {
    const before = '- id: dsh-market\r\n  config:\r\n    allowRestart: false\r\n\r\n'
    const after = '\r\n- insert:\r\n    - id: mcp-github\r\n      name: "@deepseek-ai/dsh-mcp-client"\r\n'
    const stripped = stripSkinManagedBlock(before + SAMPLE_BLOCK + after)
    expect(stripped).not.toBeNull()
    expect(stripped).not.toContain('ui-skin')
    expect(stripped).toContain('- id: dsh-market')
    expect(stripped).toContain('- id: mcp-github')
  })
  it('returns null when there is no block or the block is unterminated', () => {
    expect(stripSkinManagedBlock('[]\n')).toBeNull()
    expect(stripSkinManagedBlock('# --- dsh-skin managed (auto-generated; do not edit) ---\n- id: ui-skin-x\n  disabled: true\n')).toBeNull()
  })
})

describe('removeDanglingSkinLinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-selfheal-test-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  it('removes only dangling skin symlinks; keeps valid links and real packages', () => {
    const nm = join(root, 'node_modules')
    const scope = join(nm, '@linxin666')
    const realTarget = join(root, 'real-pkg')
    mkdirSync(join(scope, 'dsh-client-ui-skin-real', 'lib'), { recursive: true })
    mkdirSync(realTarget, { recursive: true })
    writeFileSync(join(realTarget, 'package.json'), '{}')
    try {
      symlinkSync(join(root, 'gone', 'skins', 'blue-fantasy'), join(scope, 'dsh-client-ui-skin-blue-fantasy'), 'dir')
      symlinkSync(realTarget, join(scope, 'dsh-client-ui-skin-live'), 'dir')
    } catch {
      // 无 symlink 权限的环境（部分 CI）：跳过链接断言，只验证真实目录不受影响。
      expect(existsSync(join(scope, 'dsh-client-ui-skin-real'))).toBe(true)
      return
    }
    const removed = removeDanglingSkinLinks(nm)
    expect(removed).toEqual([join(scope, 'dsh-client-ui-skin-blue-fantasy')])
    expect(existsSync(join(scope, 'dsh-client-ui-skin-live'))).toBe(true)
    expect(existsSync(join(scope, 'dsh-client-ui-skin-real'))).toBe(true)
    // 再次运行（scope 非空）：无删除、不抛。
    expect(removeDanglingSkinLinks(nm)).toEqual([])
  })
})

describe('repairSkinsBrick', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-selfheal-repair-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  it('strips both candidate patches with backups, keeps user rows, idempotent', () => {
    const profile = join(root, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    const rootPatch = join(root, 'cordis.patch.yml')
    const profilePatch = join(profile, 'cordis.patch.yml')
    writeFileSync(rootPatch, SAMPLE_BLOCK + '\r\n', 'utf8')
    writeFileSync(profilePatch, `- id: dsh-market\r\n  config:\r\n    allowRestart: false\r\n\r\n${SAMPLE_BLOCK}\r\n`, 'utf8')

    const actions = repairSkinsBrick({ dshHome: root })
    expect(actions.length).toBe(2)
    // 块独占的文件删空后落回规范空 patch（loader 拒绝空白/ null 顶层）。
    expect(readFileSync(rootPatch, 'utf8')).toBe('[]\n')
    const fixed = readFileSync(profilePatch, 'utf8')
    expect(fixed).not.toContain('ui-skin')
    expect(fixed).toContain('- id: dsh-market')
    const backups = actions.filter((line) => line.includes('backup:'))
    expect(backups.length).toBe(2)
    for (const line of backups) {
      const backup = line.slice(line.indexOf('(backup: ') + '(backup: '.length, -1)
      expect(readFileSync(backup, 'utf8')).toContain('# --- dsh-skin managed')
    }
    // 幂等：无残留时不再产生动作。
    expect(repairSkinsBrick({ dshHome: root })).toEqual([])
  })
})
