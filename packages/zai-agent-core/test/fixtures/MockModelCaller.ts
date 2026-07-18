import type { ModelCaller } from '../../src/runtime/types.js'

export type MockScenario =
  | 'text-only'
  | 'one-tool'
  | 'subagent'
  | 'infinite-loop'
  | 'error'
  | 'skill-call-then-text'
  | 'skill-not-found'

export function makeMockModelCaller(scenario: MockScenario = 'text-only'): ModelCaller {
  // Shared call counter so multi-turn scenarios (skill-call-then-text) can branch by call index.
  let turnIndex = 0
  return async function* () {
    const myTurn = turnIndex++
    if (scenario === 'text-only') {
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
      return
    }
    if (scenario === 'one-tool') {
      // queryEngine 在工具执行后会再次调 modelCaller 进入下一轮. 第一轮 yield
      // tool_use, 第二轮 (及之后) yield text-only, 这样 queryEngine 会走完 Bash 工具、
      // 拿回 output, 第二轮识别为纯文本回复、yield runtime.done 收尾.
      if (myTurn === 0) {
        yield { type: 'message_start', message: { id: 'm1' } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
        return
      }
      yield { type: 'message_start', message: { id: 'm2' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
      return
    }
    if (scenario === 'subagent') {
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Agent', input: {} } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"prompt":"sub task","subagent_type":"general-purpose"}' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
      return
    }
    if (scenario === 'infinite-loop') {
      let i = 0
      while (true) {
        yield { type: 'message_start', message: { id: `m${i}` } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
        i++
      }
    }
    if (scenario === 'error') {
      throw new Error('mock model caller error')
    }
    if (scenario === 'skill-call-then-text') {
      // First turn: yield Skill tool_use. Subsequent turns: text-only done.
      if (myTurn === 0) {
        yield { type: 'message_start', message: { id: 'm1' } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Skill', input: {} } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name":"pdf","args":"report.pdf"}' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
        return
      }
      yield { type: 'message_start', message: { id: 'm2' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
      return
    }
    if (scenario === 'skill-not-found') {
      // Every call: yield Skill tool_use with non-existent name → triggers max_turns_reached.
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Skill', input: {} } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name":"nope"}' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
      return
    }
  }
}
