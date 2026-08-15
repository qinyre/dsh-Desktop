import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const DEFAULTS = { x: 100, y: 100, width: 1200, height: 800 }

/** 窗口位置/大小持久化（设计书 §3）：坏文件回默认。 */
export class WindowStateStore {
  constructor(private readonly file: string) {}

  load(): { x: number; y: number; width: number; height: number } {
    if (!existsSync(this.file)) return { ...DEFAULTS }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      const bounds = { ...DEFAULTS, ...raw }
      for (const value of Object.values(bounds)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return { ...DEFAULTS }
      }
      return bounds as { x: number; y: number; width: number; height: number }
    } catch {
      return { ...DEFAULTS }
    }
  }

  save(bounds: { x: number; y: number; width: number; height: number }): void {
    writeFileSync(this.file, JSON.stringify(bounds), 'utf8')
  }
}
