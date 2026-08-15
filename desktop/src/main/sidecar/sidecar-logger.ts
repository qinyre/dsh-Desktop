import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** sidecar stdout/stderr 轮转落盘（设计书 §4：保留最近 5 份）。 */
export class SidecarLogger {
  readonly filePath: string
  constructor(private readonly logDir: string) {
    mkdirSync(logDir, { recursive: true })
    this.filePath = join(logDir, 'sidecar.log')
  }

  rotateSync(): void {
    rmSync(join(this.logDir, 'sidecar.log.5'), { force: true })
    for (let i = 4; i >= 1; i--) {
      const from = join(this.logDir, `sidecar.log.${i}`)
      if (existsSync(from)) renameSync(from, join(this.logDir, `sidecar.log.${i + 1}`))
    }
    if (existsSync(this.filePath)) renameSync(this.filePath, join(this.logDir, 'sidecar.log.1'))
  }

  appendLine(line: string): void {
    appendFileSync(this.filePath, `${line}\n`, 'utf8')
  }
}
