// 子模式：ELECTRON_RUN_AS_NODE 下经 dsh 公开 subprocess API 跑 powershell。
// 覆盖两个补丁位点的运行时路径：工具 spawn（收集输出 + 退出码）与 terminate/taskkill。
const fail = (message) => {
  console.error(`[hideconsole-child] FAIL: ${message}`)
  process.exit(1)
}

const { default: LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')
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
process.exit(0)
