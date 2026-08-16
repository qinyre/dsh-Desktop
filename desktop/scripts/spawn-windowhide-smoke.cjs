// 黑窗补丁冒烟（Windows）：GUI 宿主下 spawn 缺 windowsHide 会给每个控制台子进程弹黑终端。
// 家长模式：断言补丁在位；再以 ELECTRON_RUN_AS_NODE 拉起子模式跑真实 powershell。
// 子模式（spawn-windowhide-child.mjs）经公开 API LocalSubprocessRuntime.spawn 执行并回收。
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

if (process.platform !== 'win32') {
  console.log('[hideconsole-smoke] 非 Windows，跳过')
  process.exit(0)
}

const root = path.resolve(__dirname, '..')
const fail = (message) => {
  console.error(`[hideconsole-smoke] FAIL: ${message}`)
  process.exit(1)
}

// 1) 补丁存在性：三处 spawn 位点都必须带 windowsHide（升级后位点漂移在此报错）。
const sites = [
  ['@deepseek-ai/dsh-subprocess-local/lib/index.js', 'windowsHide: true,\n\t\tdetached: platform !== "win32"', '工具 spawn'],
  ['@deepseek-ai/dsh-subprocess-local/lib/index.js', '{ stdio: "ignore", windowsHide: true }', 'taskkill'],
  ['@deepseek-ai/dsh/lib/plugin-9h8shc4d.js', 'windowsHide: true,\n\t\tshell: process.platform === "win32"', 'pnpm 安装'],
]
for (const [file, needle, label] of sites) {
  const raw = readFileSync(path.join(root, 'node_modules', file), 'utf8')
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.includes(needle)) {
    const at = text.indexOf('windowsHide')
    console.error(`[hideconsole-smoke] 诊断 ${file}: size=${raw.length} CRLF=${raw.includes('\r\n')} windowsHide@${at}`)
    if (at >= 0) console.error(`[hideconsole-smoke] 上下文: ${JSON.stringify(text.slice(Math.max(0, at - 60), at + 120))}`)
    fail(`${label} 补丁缺失（${file} 不含 windowsHide 片段）`)
  }
  console.log(`[hideconsole-smoke] 补丁在位：${label}`)
}

// 2) 行为：ELECTRON_RUN_AS_NODE 下经真实 runtime 跑 powershell（无补丁时此处会弹黑窗）。
const child = spawnSync(process.execPath, [path.join(__dirname, 'spawn-windowhide-child.mjs')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  timeout: 60_000,
})
process.stdout.write(child.stdout ?? '')
process.stderr.write(child.stderr ?? '')
if (child.status !== 0) fail(`子进程退出码 ${child.status}`)
console.log('[hideconsole-smoke] PASS')
process.exit(0) // Electron 主进程不排空事件循环，显式退出（同 picker 冒烟）
