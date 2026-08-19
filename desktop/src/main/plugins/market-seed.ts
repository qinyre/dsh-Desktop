import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { resolveRuntime, type RuntimeMode } from '../sidecar/runtime-resolver'

/** 预装的市场版本：只在预装时钉住，市场自身可在设置页走更新通道升级。 */
export const DSHMARKET_SPEC = 'dshmarket@1.11.2'

/**
 * 预装的插件安装器版本（qinyre/dsh-plugin-install）：同样只在预装时钉住。
 * 0.2.0 起该标签页兼做更新器（检查更新/一键升级），并带「重启服务」按钮：
 * 桌面模式下经 dsh:restart-sidecar IPC 交回壳层（见 index.ts），无需任何
 * patch 配置覆盖——与市场不同，它没有脱离监督的自重启路径。
 * 0.2.1 起：安装/更新/卸载失败一律以 200 携带结果体返回并由页面渲染
 * 红色横幅（此前命令失败会被当成 HTTP 错误抛掉，页面毫无反馈）。
 */
export const INSTALLER_SPEC = 'dsh-plugin-install@0.2.1'

/**
 * 预装的能力管理插件版本（qinyre/dsh-plugin-capabilities，设置页一级分区「技能与 MCP」，
 * 与通用设置/模型同级，内含「技能」「MCP」「市场」三个标签页）。0.2.0 起新增：逐技能
 * 开关加载、手动注册本地/GitHub 技能仓库、技能与 MCP 两个精选市场；0.3.0 起市场条目
 * 可点开详情（技能清单、MCP 启动命令/环境变量/工具清单）；0.3.1 起收录扩容（技能仓库
 * 8 个、MCP 服务器 16 个）且详情为双语长文 + 逐技能简介；0.3.2 详情弹窗加宽到 720px
 * 并改为内部滚动（宿主弹窗固定 380px 细柱，长文会被裁切）；0.3.3 编辑弹窗再加宽到 760px，正文区新增 Markdown 预览与纯文本编辑切换（预览走宿主 MarkdownText）。
 * 同样只在预装时钉住；无需 patch 覆盖——待重启横幅在桌面模式下经 dsh:restart-sidecar
 * IPC 交回壳层。
 */
export const CAPABILITIES_SPEC = 'dsh-plugin-capabilities@0.3.3'

/**
 * 预装的归档与刻度尺插件版本（qinyre/dsh-plugin-atlas，设置页一级分区「归档管理」
 * + 对话区左缘的鱼眼刻度尺；0.2.0 起管理面板从侧边栏抽屉迁入设置页）。纯 HTTP 路由
 * 与 UI 扩展，无重启、无自更新路径，无需任何 patch 配置覆盖。同样只在预装时钉住。
 */
export const ATLAS_SPEC = 'dsh-plugin-atlas@0.2.0'

/** profile 是否已收录指定 bundle：以 dsh.profile.bundles 为准（reconcile 的落点）。 */
export function bundleSeeded(dshHome: string | undefined, name: string): boolean {
  if (dshHome === undefined) return false
  const manifest = join(dshHome, 'profiles', 'web', 'package.json')
  if (!existsSync(manifest)) return false
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
    const bundles = parsed.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes(name)
  } catch {
    return false
  }
}

/** profile 是否已装市场。 */
export function marketSeeded(dshHome: string | undefined): boolean {
  return bundleSeeded(dshHome, 'dshmarket')
}

/** profile 是否已装插件安装器。 */
export function installerSeeded(dshHome: string | undefined): boolean {
  return bundleSeeded(dshHome, 'dsh-plugin-install')
}

/** profile 是否已装能力管理插件（技能/MCP）。 */
export function capabilitiesSeeded(dshHome: string | undefined): boolean {
  return bundleSeeded(dshHome, 'dsh-plugin-capabilities')
}

/** profile 是否已装归档与刻度尺插件。 */
export function atlasSeeded(dshHome: string | undefined): boolean {
  return bundleSeeded(dshHome, 'dsh-plugin-atlas')
}

/**
 * 经 dsh CLI 预装一个 bundle，而非裸 pnpm：CLI 侧自带 profile 初始化（首启时 profile
 * 尚不存在）与 reconcile（把声明 bundle 的依赖写回 dsh.profile.bundles）。命令形态与
 * sidecar 完全一致（resolveRuntime），市场的 dshArgv() 在运行期重调 CLI 时也依赖同一形态。
 */
export async function seedBundle(opts: {
  mode: RuntimeMode
  execPath: string
  repoRoot: string
  env: NodeJS.ProcessEnv
  resolve?: (id: string) => string
  spec: string
  onOutput?: (line: string) => void
}): Promise<number> {
  const { command, args, cwd } = resolveRuntime({
    mode: opts.mode, execPath: opts.execPath, repoRoot: opts.repoRoot, resolve: opts.resolve,
    dshArgs: ['plugin', '--profile', 'web', 'add', opts.spec],
  })
  const child = spawn(command, args, { cwd: cwd ?? process.cwd(), env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) {
    if (stream !== null) createInterface({ input: stream }).on('line', (line) => opts.onOutput?.(line))
  }
  return await new Promise<number>((resolve) => {
    // close（而非 exit）：等 stdio 排空；spawn 失败只发 error 不发 exit，须兜底防挂起。
    child.once('close', (code) => resolve(code ?? 1))
    child.once('error', (error) => { opts.onOutput?.(String(error)); resolve(1) })
  })
}

/** 预装插件市场（dshmarket）。 */
export async function seedDshmarket(opts: {
  mode: RuntimeMode
  execPath: string
  repoRoot: string
  env: NodeJS.ProcessEnv
  resolve?: (id: string) => string
  spec?: string
  onOutput?: (line: string) => void
}): Promise<number> {
  return seedBundle({ ...opts, spec: opts.spec ?? DSHMARKET_SPEC })
}

/** 预装插件安装器（dsh-plugin-install，设置页的「安装」Tab）。 */
export async function seedInstaller(opts: {
  mode: RuntimeMode
  execPath: string
  repoRoot: string
  env: NodeJS.ProcessEnv
  resolve?: (id: string) => string
  spec?: string
  onOutput?: (line: string) => void
}): Promise<number> {
  return seedBundle({ ...opts, spec: opts.spec ?? INSTALLER_SPEC })
}

/** 预装能力管理插件（dsh-plugin-capabilities，设置页的「技能」「MCP」Tab）。 */
export async function seedCapabilities(opts: {
  mode: RuntimeMode
  execPath: string
  repoRoot: string
  env: NodeJS.ProcessEnv
  resolve?: (id: string) => string
  spec?: string
  onOutput?: (line: string) => void
}): Promise<number> {
  return seedBundle({ ...opts, spec: opts.spec ?? CAPABILITIES_SPEC })
}

/** 预装归档与刻度尺插件（dsh-plugin-atlas，「已归档会话」面板 + 对话刻度尺）。 */
export async function seedAtlas(opts: {
  mode: RuntimeMode
  execPath: string
  repoRoot: string
  env: NodeJS.ProcessEnv
  resolve?: (id: string) => string
  spec?: string
  onOutput?: (line: string) => void
}): Promise<number> {
  return seedBundle({ ...opts, spec: opts.spec ?? ATLAS_SPEC })
}

/** 市场行 id（其自带 cordis.patch.yml 的 insert id），配置覆盖以此为目标。 */
const MARKET_ENTRY_ID = 'dsh-market'

/**
 * 在 profile 自有 patch 层追加市场配置覆盖：关掉自重启。市场的 scheduleRestart 会经
 * 脱管 helper spawn 替代 dsh 进程再退出自身——在桌面应用的 sidecar 监督下这会留下一个
 * 无人认领的进程并触发监督器重生（双进程）；重启由应用层（sidecar.restart）负责。
 * 上游模板以空 flow 序列 `[]` 占位，须摘掉才能追加块序列项。
 */
export function applyMarketConfig(profileDir: string): void {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const content = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  if (new RegExp(`^-\\s+id:\\s*'?${MARKET_ENTRY_ID}'?\\s*$`, 'm').test(content)) return
  const stripped = content.replace(/^\s*\[\]\s*$/m, '').trimEnd()
  const block = [
    '',
    '# dsh-desktop: 市场的自重启会在应用监督外 spawn 替代进程，重启交由应用层负责。',
    `- id: ${MARKET_ENTRY_ID}`,
    '  config:',
    '    allowRestart: false',
    '',
  ].join('\n')
  writeFileSync(patchPath, stripped + block, 'utf8')
}
