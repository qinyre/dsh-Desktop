/**
 * 回合完成通知的正文摘要（设计书 §6）：从 session/follow 快照的 records 里取
 * 最后一条 agent 回复的纯文本，折叠空白后按长度截断。记录是「严格壳 + 宽 data」
 * （session-controller types.ts：{type:'event',event} 裸事件或 {type:'chunks',event}
 * 打包的 chunkrun/*），这里对一切字段做防御式读取——上游加类型、改形状都不该让
 * 通知链路抛错，最坏情形是回退通用文案。
 */

/** 通知正文的最大字符数：Windows toast 正文两三行的舒适区。 */
export const REPLY_SUMMARY_MAX_CHARS = 120

/**
 * 从记录数组（session/follow 快照的 records）里折叠出最后一条 assistant 回复文本。
 * 从尾部向前找 `assistant/message` 事件，拼接其 data.message.content 里 type==='text'
 * 的块（0.1.2-alpha 起正文挂在 message.content，旧版裸 data.content 已废）。完整的
 * assistant/message 尚未落日志时回退最近一条 `chunkrow/text-chunks` 打包行的增量拼接；
 * 找不到、或数组为空、或形状不合预期时返回 undefined（调用方回退通用文案）。
 * @param records - session/follow 快照响应里的 records 数组（JSON 已解析，形状宽泛）。
 */
export function lastAssistantText(records: unknown): string | undefined {
  if (!Array.isArray(records)) return undefined
  let chunkFallback: string | undefined
  for (let i = records.length - 1; i >= 0; i--) {
    const item = records[i] as
      | { type?: unknown; event?: { type?: unknown; data?: unknown } }
      | undefined
    if (item === undefined || item === null) continue
    const type = item.event?.type
    if (type === 'assistant/message') {
      const data = item.event?.data as { message?: { content?: unknown } } | undefined
      const text = textOfContent(data?.message?.content)
      if (text !== undefined) return text
    } else if (type === 'chunkrow/text-chunks' && chunkFallback === undefined) {
      const data = item.event?.data as { texts?: unknown } | undefined
      chunkFallback = joinedChunks(data?.texts)
    }
  }
  return chunkFallback
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

/** 拼接打包行里逐 token 的增量文本；任何一块非字符串都视为整行不可信。 */
function joinedChunks(texts: unknown): string | undefined {
  if (!Array.isArray(texts)) return undefined
  const joined = texts.every(t => typeof t === 'string') ? (texts as string[]).join('').trim() : undefined
  return joined === '' || joined === undefined ? undefined : joined
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
