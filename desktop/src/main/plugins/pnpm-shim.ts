import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter } from 'node:path'

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
    // dsh 的 plugin.ts 在 win32 用 shell:true 解析 pnpm → pnpm.cmd
    writeFileSync(`${opts.shimDir}\\pnpm.cmd`, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${opts.execPath}" "${pnpmCli}" %*\r\n`, 'utf8')
  } else {
    const file = `${opts.shimDir}/pnpm`
    writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 "${opts.execPath}" "${pnpmCli}" "$@"\n`, 'utf8')
    chmodSync(file, 0o755)
  }
  return opts.shimDir
}

export function prependPath(path: string, dir: string): string {
  // Sniff the delimiter from the existing value so PATH strings of either platform
  // are prepended deterministically; fall back to the host `path.delimiter`.
  const delim = path.includes(';') ? ';' : path.includes(':') ? ':' : delimiter
  return `${dir}${delim}${path}`
}
