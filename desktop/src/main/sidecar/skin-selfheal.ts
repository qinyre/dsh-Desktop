/**
 * 皮肤卸载残留自愈（事故兜底，非功能演进）。
 *
 * 上游事实（2026-08-17 源码级核实）：`# --- dsh-skin managed ---` 块由皮肤中心
 * 插件（@linxin666/dsh-client-ui-skin-center 的 use）写入，位置随版本在根
 * DSH_HOME 或 profiles/<web>/ 的 cordis.patch.yml 二者之一；`dsh plugin remove`
 * 只对账 package.json 的 bundles 列表，不碰 patch 也不清皮肤 symlink，皮肤中心
 * 自己的 dispose 只注销路由。于是「启用中卸载皮肤包」必然留下 insert 行 + 悬空
 * symlink，下次启动 loader 导入不存在的包 → 整棵插件树拒绝加载 → 应用起不来。
 *
 * 失败特征唯一（loader 的英文报错行，ASCII，不受 cmd 子进程 GBK 输出影响）、
 * 修复确定性（清块 + 清悬空链接，已两次在用户实机验证），适合壳层自动兜底。
 * 只修皮肤 managed 块——其他插件的行可能是用户手写配置，一律不动。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** loader 导入 ui-skin-* 条目失败的报错行（皮肤砖的唯一稳定特征）。 */
const SKIN_BRICK_SIGNATURE = /failed to import loader entry ui-skin-[a-z0-9-]+/

/** 皮肤中心 managed 段的两端标记（与该插件源码逐字一致）。 */
const MANAGED_START = '# --- dsh-skin managed (auto-generated; do not edit) ---'
const MANAGED_END = '# --- end dsh-skin managed ---'

/** sidecar 日志文本是否命中皮肤砖特征。 */
export function skinBrickDetected(logText: string): boolean {
  return SKIN_BRICK_SIGNATURE.test(logText)
}

/**
 * 移除 patch 文本中整段皮肤 managed 块。无块或块未闭合（畸形文件）返回 null
 * ——畸形时宁可不动也不半删，交给人看日志。
 * @returns 去块后的文本；无需修改时为 null。
 */
export function stripSkinManagedBlock(text: string): string | null {
  const start = text.indexOf(MANAGED_START)
  if (start === -1) return null
  const end = text.indexOf(MANAGED_END, start)
  if (end === -1) return null
  const stripped = text.slice(0, start) + text.slice(end + MANAGED_END.length)
  // 接缝处可能留下两段空行；空文件/纯空白保持原样（loader 接受空 patch 文件）。
  return stripped.replace(/\n{3,}/g, '\n\n')
}

/**
 * 删除 profile node_modules 的 @linxin666 scope 下悬空的皮肤链接：仅当条目
 * 名为 dsh-client-ui-skin-*、是 symlink、且目标已不存在时才删。真实包和
 * 指向有效目标的链接一律不动；scope 清空后顺手移除空目录。
 * @returns 被删除的条目绝对路径。
 */
export function removeDanglingSkinLinks(profileNodeModules: string): string[] {
  const scope = join(profileNodeModules, '@linxin666')
  if (!existsSync(scope)) return []
  const removed: string[] = []
  for (const entry of readdirSync(scope)) {
    if (!entry.startsWith('dsh-client-ui-skin-')) continue
    const target = join(scope, entry)
    let stat: { isSymbolicLink(): boolean }
    try {
      stat = lstatSync(target)
    } catch {
      continue
    }
    if (!stat.isSymbolicLink() || existsSync(target)) continue
    try {
      unlinkSync(target)
      removed.push(target)
    } catch {
      // 单条失败不阻断其余清理；残留链接只影响该皮肤包，不再致命。
    }
  }
  try {
    if (readdirSync(scope).length === 0) rmdirSync(scope)
  } catch {
    // 非空或并发占用都无妨。
  }
  return removed
}

/**
 * 对一个 DSH_HOME 执行完整修复：两处候选 patch（根 + profiles/<profile>）去
 * 皮肤块（先备份），profile node_modules 清悬空皮肤链接。幂等：无残留时返回
 * 空数组。文件读写失败按条目跳过（记录不到动作里即视为未修，状态机会保持
 * failed，日志可查）。
 * @returns 修复动作描述行（用于追加进 sidecar 日志）。
 */
export function repairSkinsBrick(opts: { dshHome: string; profile?: string }): string[] {
  const profile = opts.profile ?? 'web'
  const actions: string[] = []
  const candidates = [
    join(opts.dshHome, 'cordis.patch.yml'),
    join(opts.dshHome, 'profiles', profile, 'cordis.patch.yml'),
  ]
  for (const patchPath of candidates) {
    let text: string
    try {
      text = readFileSync(patchPath, 'utf8')
    } catch {
      continue
    }
    const stripped = stripSkinManagedBlock(text)
    if (stripped === null) continue
    // 删空后不能留空白文件：loader 要求顶层是 YAML 数组（null 会被拒），
    // 空 patch 的规范形状是 []。
    const out = stripped.trim() === '' ? '[]\n' : stripped
    const backup = `${patchPath}.skinheal-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
    try {
      writeFileSync(backup, text, 'utf8')
      writeFileSync(patchPath, out, 'utf8')
      actions.push(`stripped skin block from ${patchPath} (backup: ${backup})`)
    } catch {
      // 备份或写入失败：保留原文件，不记录动作。
    }
  }
  for (const link of removeDanglingSkinLinks(join(opts.dshHome, 'profiles', profile, 'node_modules'))) {
    actions.push(`removed dangling skin link ${link}`)
  }
  return actions
}
