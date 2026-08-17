/**
 * 原生标题栏跟随 dsh 网页主题（Windows）。
 *
 * 系统标题栏只有黑/白（随系统暗色模式），与 Web UI 内的主题选择脱节。这里经
 * DWM 直接上色：DWMWA_CAPTION_COLOR 定标题栏底色，DWMWA_TEXT_COLOR 定标题文字；
 * 不支持 CAPTION_COLOR 的 Win10 上，DWMWA_USE_IMMERSIVE_DARK_MODE 仍可让标题栏
 * 随主题在黑/白间切换。koffi 加载失败或非 win32 一律静默降级为系统默认——上色
 * 是锦上添花，绝不能阻断窗口创建。
 */

import type { BrowserWindow } from 'electron'
import { createRequire } from 'node:module'

const DWMWA_USE_IMMERSIVE_DARK_MODE = 20
const DWMWA_CAPTION_COLOR = 35
const DWMWA_TEXT_COLOR = 36

/** 解析 computed style 的 `rgb(r, g, b)` / `rgba(r, g, b, a)`；其余形态返回 null。 */
export function parseCssColor(css: string): [number, number, number] | null {
  const match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css.trim())
  if (match === null) return null
  const r = Number(match[1])
  const g = Number(match[2])
  const b = Number(match[3])
  if (r > 255 || g > 255 || b > 255) return null
  return [r, g, b]
}

/** COLORREF 布局是 0x00BBGGRR（写入 DWORD 时按小端即 r | g<<8 | b<<16）。 */
export function toColorRef(rgb: [number, number, number]): number {
  const [r, g, b] = rgb
  return (r | (g << 8) | (b << 16)) >>> 0
}

/** 相对亮度（WCAG 权重近似）：偏亮底色配深色标题文字。 */
export function isLightBackground(rgb: [number, number, number]): boolean {
  const [r, g, b] = rgb
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5
}

type DwmSetter = (hwnd: bigint, attr: number, value: number) => number

let setter: DwmSetter | null | undefined

/**
 * 惰性加载 dwmapi 的 DwmSetWindowAttribute；任何失败固定返回 null（不再重试）。
 * 经 createRequire 同步 require：主进程产物是 CJS（electron-vite），koffi 是
 * external 的原生模块，动态 import() 在 bundle 转换下的行为不如 require 确定。
 *
 * 句柄参数必须是 int64：koffi 对 `void*` 形参传入的 Buffer 会取「指向缓冲区数据
 * 的指针」而非句柄值，DWM 因此拿到垃圾句柄返回 E_HANDLE——v0.1.4 及之前标题栏
 * 一直没跟色的根因。value 保持 `void*` + Buffer 是对的：DWM 要的正是指向 DWORD
 * 载荷的指针。HRESULT 非零时记一次 console.warn，不再无声吞掉。
 */
function getSetter(): DwmSetter | null {
  if (setter !== undefined) return setter
  if (process.platform !== 'win32') {
    setter = null
    return setter
  }
  try {
    const koffi = createRequire(__filename)('koffi') as {
      load: (path: string) => { func: (proto: string) => (hwnd: bigint, attr: number, value: Buffer, size: number) => number }
    }
    const dwmapi = koffi.load('dwmapi.dll')
    const DwmSetWindowAttribute = dwmapi.func(
      'long __stdcall DwmSetWindowAttribute(int64 hwnd, unsigned int attr, void *value, unsigned int size)',
    )
    let warned = false
    setter = (hwnd, attr, value) => {
      const buffer = Buffer.alloc(4)
      buffer.writeUInt32LE(value, 0)
      const hr = DwmSetWindowAttribute(hwnd, attr, buffer, 4)
      if (hr !== 0 && !warned) {
        warned = true
        console.warn(`[titlebar] DwmSetWindowAttribute(attr ${attr}) failed: 0x${(hr >>> 0).toString(16)}`)
      }
      return hr
    }
  } catch (error) {
    console.warn('[titlebar] dwmapi/koffi unavailable:', error instanceof Error ? error.message : String(error))
    setter = null
  }
  return setter
}

/** 给窗口标题栏上主题色；DWM 返回错误（旧系统、无效句柄）时静默保持默认。 */
export function applyTitleBarColor(win: BrowserWindow, rgb: [number, number, number]): void {
  const set = getSetter()
  if (set === null || win.isDestroyed()) return
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0)
  const dark = !isLightBackground(rgb)
  try {
    set(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, dark ? 1 : 0)
    set(hwnd, DWMWA_CAPTION_COLOR, toColorRef(rgb))
    set(hwnd, DWMWA_TEXT_COLOR, dark ? 0x00ffffff : 0x00000000)
  } catch {
    // 降级：保持系统默认标题栏。
  }
}
