// 子模式：ELECTRON_RUN_AS_NODE 下经 dsh 公开 subprocess API 跑 powershell。
// 覆盖两个补丁位点的运行时路径：工具 spawn（收集输出 + 退出码）与 terminate/taskkill。
const fail = (message) => {
  console.error(`[hideconsole-child] FAIL: ${message}`)
  process.exit(1)
}

// pnpm 布局下传递依赖在 .pnpm/node_modules 隐藏提升位（顶层无目录），npm 扁平布局
// 才在顶层——裸 import / require.resolve 都只走顶层，统一先试两处再按文件路径导入。
const { pathToFileURL, fileURLToPath } = await import('node:url')
const { existsSync } = await import('node:fs')
const { join } = await import('node:path')
const scriptDir = fileURLToPath(new URL('.', import.meta.url))
const packageDir = (name) => {
  for (const base of ['node_modules', join('node_modules', '.pnpm', 'node_modules')]) {
    const dir = join(scriptDir, '..', base, name)
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  return fail(`cannot locate ${name} (flat or .pnpm hoist) — run pnpm install first`)
}
const { default: LocalSubprocessRuntime } = await import(
  pathToFileURL(join(packageDir('@deepseek-ai/dsh-subprocess-local'), 'lib', 'index.js')).href
)
// 构造器只要 cordis ctx 的 reflect/effect 成员（脱离插件宿主的最小桩）。
const runtime = new LocalSubprocessRuntime({ reflect: { provide: () => {} }, effect: () => () => {} })

// 1) 常规执行：输出收集 + 退出码。
const run = runtime.spawn({
  argv: ['powershell.exe', '-NoProfile', '-Command', 'Write-Output dsh-desktop-smoke'],
  cwd: process.cwd(),
  stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
  graceMs: 5000,
})
const outcome = await run.done
const collected = run.collected.stdout.finalize().text
if (outcome.exitCode !== 0) fail(`powershell 退出码 ${outcome.exitCode}`)
if (!collected.includes('dsh-desktop-smoke')) fail(`输出未收到：${JSON.stringify(collected)}`)
console.log('[hideconsole-child] 工具路径 spawn + 输出收集 OK')

// 2) 终止路径：长睡眠进程 terminate() → Windows 走 taskkill /T /F（第二个补丁位点）。
const sleeper = runtime.spawn({
  argv: ['powershell.exe', '-NoProfile', '-Command', 'Start-Sleep -Seconds 60'],
  cwd: process.cwd(),
  stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
  graceMs: 4000,
})
await new Promise((resolve) => setTimeout(resolve, 1500)) // 等子进程真正起来
if (sleeper.pid <= 0) fail('sleeper 未拿到 pid')
sleeper.terminate()
const killed = await sleeper.done
console.log(`[hideconsole-child] terminate 路径 OK（exit=${killed.exitCode} signal=${killed.signal}）`)

// 3) 完整工具链：真实 ACL 运行器（受限令牌 + 原生 CreateProcessAsUserW）执行 powershell——
//    补丁前正是这一环弹黑窗（运行器无控制台，pwsh 自建控制台）。
const { spawn } = await import('node:child_process')
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const aclRunner = join(packageDir('@deepseek-ai/dsh-sandbox-windows-acl'), 'lib', 'runner.js')
const workDir = mkdtempSync(join(tmpdir(), 'dsh-hideconsole-'))
const runner = spawn(process.execPath, [
  aclRunner, '--workspace', workDir, '--temp', tmpdir(), '--mode', 'read-only',
  '--', 'powershell.exe', '-NoProfile', '-Command', 'Write-Output acl-runner-smoke',
], { stdio: ['ignore', 'pipe', 'pipe'] })
let runnerOut = ''
let runnerErr = ''
runner.stdout.on('data', (c) => { runnerOut += c })
runner.stderr.on('data', (c) => { runnerErr += c })
const runnerCode = await new Promise((resolve) => runner.on('close', resolve))
if (runnerCode !== 0) fail(`ACL runner 退出码 ${runnerCode}，stderr: ${runnerErr.slice(0, 300)}`)
if (!runnerOut.includes('acl-runner-smoke')) fail(`ACL runner 输出未收到：${JSON.stringify(runnerOut.slice(0, 300))}`)
console.log('[hideconsole-child] ACL 运行器（原生 CreateProcessAsUserW）执行 powershell OK')
process.exit(0)
