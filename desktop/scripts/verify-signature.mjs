// dist:signed 最后一步：确认安装器真的带有效签名，防止“静默未签名”流出。
// 只认 Get-AuthenticodeSignature 的 Status=Valid（时间戳缺失、根不受信都会挡下）。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = fileURLToPath(new URL('..', import.meta.url))
const { version } = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'))
const installer = join(desktopDir, 'release', `DSH Desktop Setup ${version}.exe`)

if (!existsSync(installer)) {
  console.error(`[signing] 找不到安装器：${installer}`)
  process.exit(1)
}

const psScript = [
  `$s = Get-AuthenticodeSignature -LiteralPath '${installer.replaceAll("'", "''")}'`,
  '"STATUS=" + $s.Status',
  '"SUBJECT=" + $s.SignerCertificate.Subject',
].join('; ')
const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
  encoding: 'utf8',
})
if (run.error || run.status !== 0) {
  console.error(`[signing] 验签命令失败：${run.error ?? run.stderr}`)
  process.exit(1)
}

const status = /^STATUS=(.*)$/m.exec(run.stdout)?.[1]
const subject = /^SUBJECT=(.*)$/m.exec(run.stdout)?.[1] ?? ''
if (status === 'Valid') {
  console.log(`[signing] 安装器签名有效：${subject}`)
  console.log(`[signing] ${installer}`)
} else {
  console.error(`[signing] 签名校验未通过（Status=${status ?? '未知'}）`)
  if (subject) console.error(`[signing] 证书使用者：${subject}`)
  console.error('[signing] NotSigned → 凭据变量是否真的传进了本次构建？详见 docs/signing.md')
  process.exit(1)
}
