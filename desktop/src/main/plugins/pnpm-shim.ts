import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 免 Node 环境的 pnpm 执行（设计书 §7）：shim 把调用改写为
 * ELECTRON_RUN_AS_NODE=1 <execPath> <pnpm-cli>，使 dsh/pnpm/prepare 脚本共用同一 Node。
 */
export async function ensurePnpmShim(opts: {
  execPath: string
  shimDir: string
  resolvePnpmCli: () => string
  platform?: NodeJS.Platform
}): Promise<string> {
  const platform = opts.platform ?? process.platform
  mkdirSync(opts.shimDir, { recursive: true })
  const pnpmCli = opts.resolvePnpmCli()
  if (platform === 'win32') {
    // dsh 的 plugin.ts 在 win32 用 shell:true 解析 pnpm → pnpm.cmd（join 按宿主分隔符
    // 落名：win32 测试注入在 posix 宿主上也要写到正确的 pnpm.cmd）
    writeFileSync(join(opts.shimDir, 'pnpm.cmd'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${opts.execPath}" "${pnpmCli}" %*\r\n`, 'utf8')
  } else {
    const file = join(opts.shimDir, 'pnpm')
    writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 "${opts.execPath}" "${pnpmCli}" "$@"\n`, 'utf8')
    chmodSync(file, 0o755)
  }
  return opts.shimDir
}

export function prependPath(path: string, dir: string, platform: NodeJS.Platform = process.platform): string {
  // The separator comes from the platform, not from sniffing the value: a
  // single-entry Windows PATH ("C:\Windows\System32") carries a drive-letter
  // colon that is indistinguishable from the POSIX separator by string shape.
  const delim = platform === 'win32' ? ';' : ':'
  return `${dir}${delim}${path}`
}
