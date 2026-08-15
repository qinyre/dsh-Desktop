import { join, sep } from 'node:path'
import type { RuntimeMode } from './sidecar/runtime-resolver'

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

export function buildSidecarEnv(paths: AppPaths, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ELECTRON_RUN_AS_NODE: '1' }
  if (paths.dshHome !== undefined) env.DSH_HOME = paths.dshHome
  return env
}
