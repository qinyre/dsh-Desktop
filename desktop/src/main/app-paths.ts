import { join, sep } from 'node:path'
import type { RuntimeMode } from './sidecar/runtime-resolver'
import { prependPath } from './plugins/pnpm-shim'

export interface AppPaths {
  mode: RuntimeMode
  repoRoot: string
  dshHome: string | undefined
  logDir: string
  userDataDir: string
}

/** win32 的 join 产生 `\`；派生路径统一归一为 `/`（与 runtime-resolver 的契约约定一致）。 */
function posixJoin(...parts: string[]): string {
  return join(...parts).split(sep).join('/')
}

/**
 * 模式与数据目录（设计书 §2/§3）：打包固定 npm + 独立 DSH_HOME；
 * dev 默认 source（DESKTOP_DSH_MODE=source|npm 可切）且不动 DSH_HOME。
 */
export function resolveAppPaths(opts: {
  packaged: boolean
  env: NodeJS.ProcessEnv
  userDataDir: string
  repoRoot: string
}): AppPaths {
  const mode: RuntimeMode = opts.packaged ? 'npm' : (opts.env.DESKTOP_DSH_MODE === 'npm' ? 'npm' : 'source')
  return {
    mode,
    repoRoot: opts.repoRoot,
    dshHome: opts.packaged ? posixJoin(opts.userDataDir, 'dsh-home') : undefined,
    logDir: posixJoin(opts.userDataDir, 'logs'),
    userDataDir: opts.userDataDir,
  }
}

/**
 * sidecar 及其全部子进程的环境。shimDir 前置进 PATH 是零配置桥：dsh CLI 的
 * `spawnSync('pnpm', …, shell:true)`、插件市场重调的 CLI 子进程、prepare 脚本都
 * 由此在无 Node 机器上找到 pnpm（shim 由 ensurePnpmShim 生成）。
 * DSH_DESKTOP=1 标记「运行在桌面客户端内」：dsh-plugin-install 等 host 插件据此
 * 判断走客户端通道（shim）而非系统 npm/pnpm，并禁用脱离监督的自重启。
 */
export function buildSidecarEnv(
  paths: AppPaths,
  base: NodeJS.ProcessEnv,
  opts: { shimDir?: string } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP: '1' }
  if (paths.dshHome !== undefined) env.DSH_HOME = paths.dshHome
  if (opts.shimDir !== undefined) {
    // Windows 环境块键大小写不敏感（PATH 实际多以 Path 落键），普通对象不然：
    // 写 env.PATH 会另立新键而非改写原键，子进程只认"最后出现"的那个——
    // 原 PATH 被整个遮蔽，sidecar 全树（MCP 的 cmd/npx、agent 命令）只剩
    // shimDir 可解析。必须先找到既有键名、在原键上前置。
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    env[pathKey] = prependPath(env[pathKey] ?? '', opts.shimDir)
  }
  return env
}
