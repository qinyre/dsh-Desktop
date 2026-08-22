/**
 * 回合完成通知的正文摘要（设计书 §6）：从 session.history 的事件页里取最后一条
 * agent 回复的纯文本，折叠空白后按长度截断。事件信封是「严格壳 + 宽 data」
 * （apiproxy sessions.schema），这里对一切字段做防御式读取——上游加类型、改
 * 形状都不该让通知链路抛错，最坏情形是回退通用文案。
 */

/** 通知正文的最大字符数：Windows toast 正文两三行的舒适区。 */
export const REPLY_SUMMARY_MAX_CHARS = 120

/**
 * 从事件数组（session.history 的 events 页）里折叠出最后一条 assistant 回复文本。
 * 从尾部向前找 `assistant/message`，拼接其 content 里 type==='text' 的块。
 * 实测（0.1.1-rc.1）history 页的事件带一层 {event:{…}} 包装，裸事件形状也一并
 * 兼容；找不到、或事件页为空、或形状不合预期时返回 undefined（调用方回退通用文案）。
 * @param events - session/history 响应里的 events 数组（JSON 已解析，形状宽泛）。
 */
export function lastAssistantText(events: unknown): string | undefined {
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const item = events[i] as { type?: unknown; data?: unknown; event?: { type?: unknown; data?: unknown } } | undefined
    if (item === undefined || item === null) continue
    const type = item.event?.type ?? item.type
    if (type !== 'assistant/message') continue
    const data = (item.event?.data ?? item.data) as { content?: unknown } | undefined
    const text = textOfContent(data?.content)
    if (text !== undefined) return text
  }
  return undefined
}

/** 拼接 content 块数组中的 text 块；非数组或没有文本块时返回 undefined。 */
function textOfContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | undefined
    if (b === undefined || b === null) continue
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') parts.push(b.text)
  }
  const joined = parts.join('\n').trim()
  return joined === '' ? undefined : joined
}

/**
 * 折叠全部空白（含换行）为单空格并按 maxChars 截断加省略号。
 * 截断在码点边界上（Array.from），中文与 emoji 都不会切出半个字。
 */
export function summarizeReply(text: string, maxChars: number = REPLY_SUMMARY_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return ''
  const chars = Array.from(collapsed)
  if (chars.length <= maxChars) return collapsed
  return chars.slice(0, Math.max(0, maxChars - 1)).join('') + '…'
}
