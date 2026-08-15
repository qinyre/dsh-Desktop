/** 崩溃退避（设计书 §4）：attempt 从 1 起计，1000ms 起、倍增、封顶 4000ms。 */
export function backoffDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 4000)
}
