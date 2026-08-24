import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

/** 可注入的执行器（单测用）；抛错形态对齐 execFile——ENOENT=工具不存在，killed=超时。 */
export type DbusExec = (cmd: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>

const PROBE_TIMEOUT_MS = 2_500
const cache = new Map<string, boolean | null>()

const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
const isTimeout = (error: unknown): boolean => (error as { killed?: boolean } | undefined)?.killed === true

/**
 * DBus 会话总线 well-known name 探测（Linux 桌面能力判定）。
 * 返回 true/false=确定结论，null=探测工具不可用/超时（未知）。
 * 每个 name 每进程只探测一次（结果缓存）；失败语义见调用方——未知一律按「能力缺席」处理。
 */
export async function probeDbusName(name: string, exec: DbusExec = defaultExec): Promise<boolean | null> {
  if (cache.has(name)) return cache.get(name) ?? null
  const result = await probeOnce(name, exec)
  cache.set(name, result)
  return result
}

async function probeOnce(name: string, exec: DbusExec): Promise<boolean | null> {
  try {
    const { stdout } = await exec('busctl', [
      '--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', 's', name,
    ], { timeout: PROBE_TIMEOUT_MS })
    return /b\s+true/.test(stdout)
  } catch (error) {
    // 工具在但跑不通（无会话总线 "Failed to connect to bus" 等）= 服务确定缺席；
    // 超时 = 未知。ENOENT = 换下一个工具。
    if (isEnoent(error)) { /* fall through to gdbus */ }
    else if (isTimeout(error)) return null
    else return false
  }
  try {
    const { stdout } = await exec('gdbus', [
      'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner', name,
    ], { timeout: PROBE_TIMEOUT_MS })
    // gdbus 的 GVariant 文本输出：布尔返回打印为 "(true,)"——引号只用于字符串值。
    return /\(true,\)/.test(stdout)
  } catch (error) {
    // 最后一个工具：缺失（ENOENT）或超时都意味着「探测不出来」= 未知；工具在但总线
    // 缺席 = 服务确定不存在。
    if (isEnoent(error) || isTimeout(error)) return null
    return false
  }
}

async function defaultExec(cmd: string, args: string[], opts: { timeout: number }): Promise<{ stdout: string }> {
  return execFile(cmd, args, { timeout: opts.timeout })
}
