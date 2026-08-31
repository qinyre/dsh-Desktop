import { describe, expect, it } from 'vitest'
import { lastAssistantText, summarizeReply } from './reply-summary'

/** 0.1.2-alpha session/follow 快照记录：{type:'event',event} 裸事件壳。 */
const eventRecord = (type: string, data: unknown) => ({ type: 'event', event: { type, seq: 0, time: 0, data } })

describe('lastAssistantText（从快照 records 折叠最后一条 agent 回复）', () => {
  it('取 assistant/message 的 data.message.content 文本块', () => {
    const records = [
      eventRecord('user/message', { message: { content: [{ type: 'text', text: '问题' }] } }),
      eventRecord('assistant/message', {
        turn: 1, step: 1,
        message: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] },
      }),
    ]
    expect(lastAssistantText(records)).toBe('第一段\n第二段')
  })

  it('从尾部向前找最近的 assistant/message', () => {
    const records = [
      eventRecord('assistant/message', { message: { content: [{ type: 'text', text: '旧回复' }] } }),
      eventRecord('assistant/message', { message: { content: [{ type: 'text', text: '新回复' }] } }),
    ]
    expect(lastAssistantText(records)).toBe('新回复')
  })

  it('跳过空文本与纯非文本块的消息', () => {
    const records = [
      eventRecord('assistant/message', { message: { content: [{ type: 'image' }] } }),
      eventRecord('assistant/message', { message: { content: [{ type: 'text', text: '   ' }] } }),
      eventRecord('assistant/message', { message: { content: [{ type: 'text', text: '最终' }] } }),
    ]
    expect(lastAssistantText(records)).toBe('最终')
  })

  it('无完整消息时回退最近一条 chunkrow/text-chunks 打包行', () => {
    const records = [
      eventRecord('user/message', { message: { content: [{ type: 'text', text: '问题' }] } }),
      { type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 3, time: 0, data: { turn: 1, step: 1, index: 0, dt: [], texts: ['你', '好'] } } },
    ]
    expect(lastAssistantText(records)).toBe('你好')
  })

  it('assistant/message 优先于更近的打包行', () => {
    const records = [
      { type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 1, time: 0, data: { texts: ['增量'] } } },
      eventRecord('assistant/message', { message: { content: [{ type: 'text', text: '完整消息' }] } }),
      { type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 5, time: 0, data: { texts: ['更近的增量'] } } },
    ]
    expect(lastAssistantText(records)).toBe('完整消息')
  })

  it('非数组、空数组、形状不合时返回 undefined', () => {
    expect(lastAssistantText(undefined)).toBeUndefined()
    expect(lastAssistantText(null)).toBeUndefined()
    expect(lastAssistantText([])).toBeUndefined()
    expect(lastAssistantText([{ type: 'event', event: { type: 'user/message' } }])).toBeUndefined()
    expect(lastAssistantText([{ type: 'event', event: { type: 'assistant/message' } }])).toBeUndefined()
    expect(lastAssistantText([{ type: 'chunks', event: { type: 'chunkrow/reasoning-chunks', data: { texts: ['思考'] } } }])).toBeUndefined()
  })
})

describe('summarizeReply（折叠空白 + 码点安全截断）', () => {
  it('折叠换行与连续空白为单空格', () => {
    expect(summarizeReply('  第一行\n\n第二行   结束  ')).toBe('第一行 第二行 结束')
  })

  it('超长时按 maxChars 截断加省略号', () => {
    const text = '字'.repeat(200)
    const out = summarizeReply(text, 120)
    expect(out.length).toBe(120)
    expect(out.endsWith('…')).toBe(true)
    expect(out.startsWith('字'.repeat(119))).toBe(true)
  })

  it('不切半个代理对字符', () => {
    const out = summarizeReply('😀'.repeat(80), 10)
    expect(out).toBe('😀'.repeat(9) + '…')
  })

  it('空白串折叠为空', () => {
    expect(summarizeReply('  \n\t ')).toBe('')
  })
})
