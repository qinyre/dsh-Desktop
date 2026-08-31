/**
 * Parse the dsh supervisor readiness line for the sidecar port and launch
 * token（设计书 §4：恒为纯 loopback URL；LAN 后缀仅防御性容错）。
 * dsh 0.1.2-alpha 起就绪行携带进程令牌（`?token=`，浏览器会话 cookie 的兑换
 * 凭据，见 browser-auth.ts）；旧运行时无 token，parsed.token 为 undefined。
 */
export interface ReadyLine {
  port: number
  token: string | undefined
}

export function parseReadyLine(line: string): ReadyLine | undefined {
  const match = /^dsh web: http:\/\/127\.0\.0\.1:(\d+)(\S*)/.exec(line)
  if (match === null) return undefined
  const token = /[?&]token=([^&\s)]+)/.exec(match[2])?.[1]
  return { port: Number(match[1]), token: token === undefined ? undefined : decodeURIComponent(token) }
}

/** 兼容入口：只取端口的调用方沿用旧签名。 */
export function parseReadyPort(line: string): number | undefined {
  return parseReadyLine(line)?.port
}
