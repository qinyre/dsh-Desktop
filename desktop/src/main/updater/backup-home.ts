import { existsSync } from 'node:fs'
import { cp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** 更新前备份 DSH_HOME（设计书 §8：会话+凭据+设置；保留最近 1 份）。 */
export async function backupDshHome(dshHome: string, backupRoot: string, now: () => Date = (): Date => new Date()): Promise<string> {
  if (!existsSync(dshHome)) return ''
  const dest = join(backupRoot, `dsh-home-${stamp(now())}`)
  await cp(dshHome, dest, { recursive: true })
  const entries = (await readdir(backupRoot)).filter((name) => name.startsWith('dsh-home-')).sort()
  for (const old of entries.slice(0, -1)) await rm(join(backupRoot, old), { recursive: true, force: true })
  return dest
}
