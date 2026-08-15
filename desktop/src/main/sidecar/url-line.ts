/**
 * Parse the dsh supervisor readiness line for the sidecar port
 * (设计书 §4：恒为纯 loopback URL；LAN 后缀仅防御性容错)。
 * @param line - one stdout line from the sidecar.
 * @returns the port, or undefined when the line is not a readiness line.
 */
export function parseReadyPort(line: string): number | undefined {
  const match = /^dsh web: http:\/\/127\.0\.0\.1:(\d+)/.exec(line)
  return match === null ? undefined : Number(match[1])
}
