// Directory-picker readUtf16 smoke: guards the patch-package fix for
// koffi.view() fatal-erroring under Electron's embedded Node (the packaged
// app's workspace picker died with "win32 folder dialog worker exited before
// reporting a result" — FATAL Error::New napi_get_last_error_info in
// readUtf16). Two checks:
//   1. the installed worker.cjs actually carries the patch (no koffi.view),
//   2. the decode-based readUtf16 path decodes a real IShellItem
//      GetDisplayName(SIGDN_FILESYSPATH) under a real ELECTRON_RUN_AS_NODE
//      child of this Electron build.
// Run via `npm run smoke:picker` (electron CLI). Non-win32 prints skip.
'use strict'

function fail(message) {
  console.error(`[smoke:picker] FAIL: ${message}`)
  process.exit(1)
}

// Child mode: the COM probe, run under ELECTRON_RUN_AS_NODE exactly like the
// dsh dialog worker. readUtf16 mirrors the patched worker.cjs — keep in sync
// with patches/@deepseek-ai+dsh-host-directory-picker-native*.patch.
if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  const path = require('node:path')
  const koffi = require('koffi')

  const readUtf16 = (address) => {
    const units = []
    for (let offset = 0; offset + 1 < 32768; offset += 2) {
      const unit = koffi.decode(address, offset, 'int16')
      if (unit === 0) break
      units.push(unit)
    }
    const bytes = Buffer.alloc(units.length * 2)
    for (let i = 0; i < units.length; i++) bytes.writeUInt16LE(units[i], i * 2)
    return bytes.toString('utf16le')
  }

  const guidBytes = (text) => {
    const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text)
    const bytes = Buffer.alloc(16)
    bytes.writeUInt32LE(parseInt(match[1], 16), 0)
    bytes.writeUInt16LE(parseInt(match[2], 16), 4)
    bytes.writeUInt16LE(parseInt(match[3], 16), 6)
    Buffer.from(match[4] + match[5], 'hex').copy(bytes, 8)
    return bytes
  }

  const IID_ISHELL_ITEM = guidBytes('43826d1e-e718-42ee-bc55-a1e261c37bfe')
  const SIGDN_FILESYSPATH = 0x80058000 | 0
  const pointerSize = koffi.sizeof('void *')
  const shell32 = koffi.load('shell32.dll')
  const ole32 = koffi.load('ole32.dll')
  const coInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32'])
  const coTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *'])
  const createItem = shell32.func('__stdcall', 'SHCreateItemFromParsingName', 'int32', ['str16', 'void *', 'void *', 'void *'])
  const protoGetDisplayName = koffi.proto('int32 __stdcall DshItemGetDisplayName(void *self, int32 form, _Out_ void **name)')
  const protoRelease = koffi.proto('uint32 __stdcall DshComRelease(void *self)')

  coInitializeEx(null, 0x2)
  const target = path.resolve(process.env.USERPROFILE, '..')
  const out = Buffer.alloc(pointerSize)
  const hr = createItem(target, null, IID_ISHELL_ITEM, out)
  if (hr < 0) fail(`SHCreateItemFromParsingName hr=0x${(hr >>> 0).toString(16)}`)
  const item = koffi.decode(out, 'void *')
  const vtable = koffi.decode(item, 'void *')
  const getName = koffi.decode(vtable, 5 * pointerSize, 'void *')
  const release = koffi.decode(vtable, 2 * pointerSize, 'void *')
  const nameOut = [null]
  const gotName = koffi.call(getName, protoGetDisplayName, item, SIGDN_FILESYSPATH, nameOut)
  const decoded = readUtf16(nameOut[0])
  coTaskMemFree(nameOut[0])
  koffi.call(release, protoRelease, item)
  const ok = decoded.toLowerCase() === target.toLowerCase()
  console.log(`[smoke:picker] GetDisplayName -> ${JSON.stringify(decoded)} | match=${ok}`)
  process.exit(ok ? 0 : 1)
}

// Parent mode.
if (process.platform !== 'win32') {
  console.log('[smoke:picker] skip: win32-only')
  process.exit(0)
}

const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

// 补丁位点的文件解析要兼容两种布局：npm 扁平（顶层）与 pnpm（传递依赖在
// .pnpm/node_modules 隐藏提升位，顶层没有目录）。补丁经 pnpm patchedDependencies
// 作用于两处共用的 store 真身。
const readInstalled = (relative) => {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', relative),
    path.join(__dirname, '..', 'node_modules', '.pnpm', 'node_modules', relative),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
  }
  return null
}
const workerSrc = readInstalled(path.join('@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs'))
if (workerSrc === null) fail('worker.cjs not found (flat or .pnpm hoist) — run pnpm install first')
if (workerSrc.includes('koffi.view(address')) fail('patch not applied: worker.cjs still calls koffi.view() (pnpm install must apply patchedDependencies)')
if (!workerSrc.includes('koffi.decode(address')) fail('patch not applied: decode-based readUtf16 missing from worker.cjs')

const child = spawnSync(process.execPath, [__filename], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  windowsHide: true,
})
process.stdout.write(child.stdout ?? '')
process.stderr.write(child.stderr ?? '')
if (child.status !== 0) fail(`ELECTRON_RUN_AS_NODE probe exited ${child.status}`)
console.log('[smoke:picker] PASS')
process.exit(0)
