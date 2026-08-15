import type { ChildProcess } from 'node:child_process'

/**
 * 平台 kill 适配（设计书 §4：唯一平台分叉点）。
 * 所有平台都等待 exit 事件返回——stop()/restart() 依赖"旧 child 确已终止"
 * 才能保证不出现新旧 sidecar 并存。Windows 的 child.kill() 是硬终止，
 * 落盘安全由上游 torn-tail 修复不变量保证；POSIX 先 SIGTERM 走上游优雅
 * dispose，2s 未退再 SIGKILL。
 */
export async function killSidecar(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
  const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()) })
  let terminated = false
  child.once('exit', () => { terminated = true })
  if (platform === 'win32' || child.killed) {
    child.kill()
  } else {
    child.kill('SIGTERM')
    setTimeout(() => { if (!terminated) child.kill('SIGKILL') }, 2000)
  }
  await exited
}
