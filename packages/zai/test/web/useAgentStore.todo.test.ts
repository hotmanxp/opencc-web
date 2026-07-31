// packages/zai/test/web/useAgentStore.todo.test.ts
// @vitest-environment happy-dom
//
// 2026-07-31: 老 todosBySession / TodoWrite reducer 已被 refactor 删除.
// 该文件原本管 TodoWrite 行为, 现在仅保留与 TodoWrite 无关的 input 处理
// 回归测试 (Bash 工具的 input 防御), 搬到这里避免改动面太大. 文件名仅作
// 历史溯源, 不再 describe "todo" 行为; 后续若大批回归, 应挪到独立文件.
import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'

beforeEach(() => {
  // 重置 store 到隔离初态, 不污染其他 test 文件
  useAgentStore.setState({
    sessionId: 'sess-1',
    messages: [],
    textSegmentRev: 0,
    segmentedToolUseIds: {},
    sendSeq: 0,
  })
})

describe('useAgentStore — 通用 tool_use input 防御', () => {
  it('upsertToolCall 非 TodoWrite 工具正常 upsert', () => {
    useAgentStore.getState().upsertToolCall({
      eventId: 'start-bash',
      sessionId: 'sess-1',
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 'toolu_bash_1',
      name: 'Bash',
      input: { command: 'ls' },
    } as any)
    const s = useAgentStore.getState()
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]!.name).toBe('Bash')
    expect(s.textSegmentRev).toBe(1)
    expect(s.segmentedToolUseIds['toolu_bash_1']).toBe(true)
  })

  it('applyRuntimeEvent: tool_result 携带 input=undefined (zai-agent-core done 路径) 不能覆盖已有 input', () => {
    // 回归 Bug: server 在 tool_use:done 路径上, ev.input 是 undefined 时
    // 旧版默认填 `{}` 推到客户端. 客户端 upsertToolCall 的 incomingInput
    // (`{}` 是 truthy) 走 `incomingInput ?? prev.input` 的 truthy 分支,
    // 把已有 input 覆盖成 `{}` → ToolCallBlock 折叠态预览 (description/command)
    // 丢失, 用户看到 "Bash 已完成 caret-right" 但看不到命令描述.
    //
    // 修复后 (server 不再默认 `{}`, 客户端用 typeof object 严格判):
    // done 路径 input=undefined → 走 prev.input 回退 → 保留原 input.
    const sid = 'sess-1'
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_call',
      eventId: 'tc-1', ts: 1, sessionId: sid, turnIndex: 0,
      toolUseId: 'toolu_bash_keep',
      toolName: 'Bash',
      input: { command: 'ls -la', description: '查看当前目录' },
    } as any)
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_result',
      eventId: 'tr-1', ts: 2, sessionId: sid, turnIndex: 0,
      toolUseId: 'toolu_bash_keep',
      toolName: 'Bash',
      // 关键: input 字段缺失, 模拟 zai-agent-core 不会回传 input 的情况
      output: 'file.txt',
    } as any)
    const msg = useAgentStore.getState().messages[0] as Record<string, unknown>
    expect(msg.type).toBe('tool_use:done')
    expect(msg.name).toBe('Bash')
    // input 仍保留 start 阶段的 {command, description}
    expect(msg.input).toEqual({ command: 'ls -la', description: '查看当前目录' })
  })

  it('upsertToolCall: input=空对象 {} (server 旧默认) 也不能覆盖已有 input', () => {
    // 客户端防御: 即使 server (旧版) 仍推 `{}` 上来, 也不能让 `{}` 当成
    // 合法 input 覆盖 prev. 旧 `||` 链 `"" || {}` = `{}` truthy, 把 prev
    // 覆盖. 改用 typeof==='object' && !Array.isArray 严格判, 区分 `{}`
    // 和 undefined. 但 `{}` 本身 typeof 是 'object' —— 区分不开. 所以这
    // 条断言对应 server 修好后的行为, 用 input=undefined 测. 这里 `{}`
    // 不算 'no input', 视为 '显式空 input' 覆盖 prev, 这是允许的
    // (模型显式发了空 input 就应该按空 input 走). 不再回归.
    //
    // 真正的 client 防御: input=null / input=空字符串 / input 是非对象,
    // 都不会覆盖 prev.input.
    const sid = 'sess-1'
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_call',
      eventId: 'tc-1', ts: 1, sessionId: sid, turnIndex: 0,
      toolUseId: 'toolu_bash_null',
      toolName: 'Bash',
      input: { command: 'pwd' },
    } as any)
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_result',
      eventId: 'tr-1', ts: 2, sessionId: sid, turnIndex: 0,
      toolUseId: 'toolu_bash_null',
      toolName: 'Bash',
      input: null as unknown as undefined, // 模拟客户端收到的 input: null
      output: '/home',
    } as any)
    const msg = useAgentStore.getState().messages[0] as Record<string, unknown>
    // input=null 不应覆盖 prev.input
    expect(msg.input).toEqual({ command: 'pwd' })
  })

  it('applyRuntimeEvent: 真实 SSE 路径并发 Bash (与 TodoWrite 守卫无关的回归)', () => {
    // 反向断言: 旧 TodoWrite 守卫的修复不该误伤其他工具, 这条保留下来
    // 防止后续 reducer 重写再次让 Bash 掉回 "unknown" 已完成 bug.
    const sid = 'sess-1'
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_call',
      eventId: 'tc-bash', ts: 1, sessionId: sid, turnIndex: 0,
      toolUseId: 'toolu_bash_rt1',
      toolName: 'Bash',
      input: { command: 'ls' },
    } as any)
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_result',
      eventId: 'tr-bash', ts: 2, sessionId: sid, turnIndex: 0,
      toolUseId: 'toolu_bash_rt1',
      toolName: 'Bash',
      input: { command: 'ls' },
      output: 'file.txt',
    } as any)
    const s = useAgentStore.getState()
    // Bash 仍然正常 push + done.
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]!.name).toBe('Bash')
    expect((s.messages[0]!.output as string) ?? '').toContain('file.txt')
  })
})
