// 打包产物自检（发布前必跑，npm run verify:bundle）。
//
// 背景：ELECTRON_RUN_AS_NODE 的 sidecar 只能从 app.asar.unpacked 解析模块，而
// electron-builder 按 package.json 的 dependencies 边收集闭包——上游 dsh 若把运行时
// 静态导入的包声明成 peerDependencies（npm 7+ 会自动装、开发环境无感），这些包就会
// 整体从产物里消失，打包后的 dsh 在首次 import 即崩（v0.1.0–v0.1.3 的缺陷）。
//
// 两道检查：
//  1. 闭包检查：扫描产物内 @deepseek-ai 代码 import 的每个 @deepseek-ai/<pkg>，
//     目标目录必须存在于 app.asar.unpacked。
//  2. 启动检查：把 win-unpacked 复制到无 node_modules 祖先的临时目录（防止解析
//     逃逸进开发树造成假阳性），用 ELECTRON_RUN_AS_NODE 按打包模式真实拉起
//     `dsh web`，等待 stdout 就绪行。
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const unpacked = process.argv[2] ?? join(import.meta.dirname, '..', 'release', 'win-unpacked', 'resources', 'app.asar.unpacked')
const scopedRoot = join(unpacked, 'node_modules', '@deepseek-ai')
let failed = false
const fail = (msg) => { console.error(`FAIL ${msg}`); failed = true }

if (!existsSync(scopedRoot)) {
  fail(`bundle not found: ${scopedRoot}（先 npm run dist）`)
  process.exit(1)
}

// --- 1. import 闭包检查 ------------------------------------------------------
const importRe = /from\s+["'](@deepseek-ai\/[a-z0-9-]+)["']|import\(\s*["'](@deepseek-ai\/[a-z0-9-]+)["']\s*\)|require\(\s*["'](@deepseek-ai\/[a-z0-9-]+)["']\s*\)/g
const bundled = new Set(readdirSync(scopedRoot))
const needed = new Map()
const scan = (dir, pkg) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) scan(p, pkg)
    else if (/\.(js|mjs|cjs)$/.test(e.name)) {
      for (const m of readFileSync(p, 'utf8').matchAll(importRe)) {
        const dep = m[1] ?? m[2] ?? m[3]
        if (dep !== `@deepseek-ai/${pkg}` && !needed.has(dep)) needed.set(dep, pkg)
      }
    }
  }
}
for (const pkg of bundled) {
  const lib = join(scopedRoot, pkg, 'lib')
  if (existsSync(lib)) scan(lib, pkg)
}
for (const [dep, firstSeen] of needed) {
  if (!bundled.has(dep.replace('@deepseek-ai/', ''))) fail(`bundled code imports ${dep} (first seen in ${firstSeen}) but it is missing from the bundle`)
}
console.log(`closure: ${bundled.size} @deepseek-ai packages, ${needed.size} imported — ${failed ? 'BROKEN' : 'ok'}`)

// --- 2. 隔离启动检查 ---------------------------------------------------------
const exe = join(unpacked, '..', '..', 'DSH Desktop.exe')
if (!existsSync(exe)) {
  fail(`app exe not found: ${exe}`)
} else {
  const iso = mkdtempSync(join(tmpdir(), 'dsh-bundle-verify-'))
  const appDir = join(iso, 'win-unpacked')
  const home = join(iso, 'dsh-home')
  console.log(`boot: copying win-unpacked to ${appDir} (isolated — no dev node_modules ancestors)`)
  cpSync(join(unpacked, '..', '..'), appDir, { recursive: true })
  const entry = join(appDir, 'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const child = spawn(exe, ['--expose-internals', entry, 'web', '--no-open', '--port', '0', '--host', '127.0.0.1'], {
    cwd: iso,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: home,
      PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'system32'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { out += c })
  const ready = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 120_000)
    const poll = setInterval(() => {
      const m = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/.exec(out)
      if (m) { clearTimeout(t); clearInterval(poll); resolve(m[1]) }
      if (child.exitCode !== null) { clearTimeout(t); clearInterval(poll); resolve(null) }
    }, 250)
  })
  child.kill()
  await new Promise((r) => child.once('close', r))
  if (ready) console.log(`boot: dsh web ready on :${ready} — ok`)
  else fail(`packaged sidecar never reached readiness (exit ${child.exitCode}); tail:\n${out.slice(-800)}`)
  rmSync(iso, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
