import { describe, expect, it } from 'vitest'
import { lastAssistantText, summarizeReply } from './reply-summary'

describe('lastAssistantText（从事件页折叠最后一条 agent 回复）', () => {
  it('识别 history 页实测的 {event:{…}} 包装形状', () => {
    // 0.1.1-rc.1 实机响应：events 数组每项是 {event:{type,seq,time,data}}
    const events = [
      { event: { type: 'permission/preset', seq: 0, data: { preset: 'workspace-write' } } },
      { event: { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '问题' }] } } },
      { event: { type: 'assistant/message', seq: 2, time: 1, data: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } } },
    ]
    expect(lastAssistantText(events)).toBe('第一段\n第二段')
  })

  it('从尾部向前找最近的 assistant/message，兼容裸事件形状', () => {
    const events = [
      { type: 'user/message', data: { content: [{ type: 'text', text: '问题' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '旧回复' }] } },
      { type: 'assistant/message', seq: 9, data: { content: [{ type: 'text', text: '新回复第一段' }, { type: 'text', text: '第二段' }] } },
    ]
    expect(lastAssistantText(events)).toBe('新回复第一段\n第二段')
  })

  it('跳过空文本与纯非文本块的消息', () => {
    const events = [
      { event: { type: 'assistant/message', data: { content: [{ type: 'image' }] } } },
      { event: { type: 'assistant/message', data: { content: [{ type: 'text', text: '   ' }] } } },
      { event: { type: 'assistant/message', data: { content: [{ type: 'text', text: '最终' }] } } },
    ]
    expect(lastAssistantText(events)).toBe('最终')
  })

  it('非数组、空数组、没有 assistant/message 时返回 undefined', () => {
    expect(lastAssistantText(undefined)).toBeUndefined()
    expect(lastAssistantText(null)).toBeUndefined()
    expect(lastAssistantText([])).toBeUndefined()
    expect(lastAssistantText([{ type: 'user/message' }])).toBeUndefined()
    expect(lastAssistantText([{ event: { type: 'step/start' } }])).toBeUndefined()
    expect(lastAssistantText([{ event: { type: 'assistant/message' } }])).toBeUndefined()
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
