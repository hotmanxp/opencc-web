// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest'
import { lastAssistantTextIndex } from './deriveStreamLive.js'
import type { AgentMessage } from '../../store/useAgentStore.js'

function userText(eventId: string): AgentMessage {
  return { eventId, sessionId: 's1', ts: 1, turnIndex: 0, type: 'user.text', text: 'hi' } as unknown as AgentMessage
}
function thinking(eventId: string, text = 'reasoning'): AgentMessage {
  return { eventId, sessionId: 's1', ts: 1, turnIndex: 0, type: 'assistant.thinking', thinking: text } as unknown as AgentMessage
}
function assistantText(eventId: string, text = 'reply'): AgentMessage {
  return { eventId, sessionId: 's1', ts: 1, turnIndex: 0, type: 'assistant.text', text } as unknown as AgentMessage
}

describe('lastAssistantTextIndex', () => {
  test('空数组返回 -1', () => {
    expect(lastAssistantTextIndex([])).toBe(-1)
  })
  test('只含 user/thinking 时返回 -1', () => {
    const msgs = [userText('u1'), thinking('t1')]
    expect(lastAssistantTextIndex(msgs)).toBe(-1)
  })
  test('找到最后一条 assistant.text 的下标', () => {
    const msgs = [userText('u1'), assistantText('a1'), userText('u2'), assistantText('a2'), thinking('t1')]
    expect(lastAssistantTextIndex(msgs)).toBe(3)
  })
})
