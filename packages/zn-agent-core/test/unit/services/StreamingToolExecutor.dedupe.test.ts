// zai patch (2026-08-08): 并行工具去重判定测试。
// 模型在同一轮响应里重复提交相同 (name, input) 工具时只执行一次,
// 避免同一命令并行执行两次放大上游请求(会话 sess-1786201578807 现场:
// 429 前同一 `pnpm test` 命令被并行提交两次)。
import { describe, it, expect } from 'vitest'
import { findDuplicateTrackedTool } from '../../../src/opencc-src/services/tools/toolDedupe.js'

function toolUse(id: string, name: string, input: unknown) {
  return { id, name, input, type: 'tool_use' as const }
}

describe('findDuplicateTrackedTool(并行工具去重判定)', () => {
  it('相同 (name, input) 且 queued 时命中', () => {
    const tools = [
      { status: 'queued' as const, block: toolUse('call_1', 'bash', { command: 'pnpm test' }) },
    ]
    const dup = findDuplicateTrackedTool(
      tools,
      toolUse('call_2', 'bash', { command: 'pnpm test' }),
    )
    expect(dup).toEqual({ id: 'call_1', name: 'bash' })
  })

  it('相同 (name, input) 且 executing 时命中', () => {
    const tools = [
      { status: 'executing' as const, block: toolUse('call_1', 'bash', { command: 'git status' }) },
    ]
    const dup = findDuplicateTrackedTool(
      tools,
      toolUse('call_2', 'bash', { command: 'git status' }),
    )
    expect(dup?.id).toBe('call_1')
  })

  it('input 的 JSON key 顺序不同仍命中(stableStringify 指纹)', () => {
    const tools = [
      { status: 'queued' as const, block: toolUse('call_1', 'bash', { command: 'git status', cwd: '/tmp' }) },
    ]
    const dup = findDuplicateTrackedTool(
      tools,
      toolUse('call_2', 'bash', { cwd: '/tmp', command: 'git status' }),
    )
    expect(dup).toBeTruthy()
  })

  it('input 不同不命中', () => {
    const tools = [
      { status: 'queued' as const, block: toolUse('call_1', 'bash', { command: 'pnpm test a' }) },
    ]
    const dup = findDuplicateTrackedTool(
      tools,
      toolUse('call_2', 'bash', { command: 'pnpm test b' }),
    )
    expect(dup).toBeNull()
  })

  it('工具名不同不命中', () => {
    const tools = [
      { status: 'queued' as const, block: toolUse('call_1', 'bash', { command: 'git status' }) },
    ]
    const dup = findDuplicateTrackedTool(
      tools,
      toolUse('call_2', 'grep', { pattern: 'git status' }),
    )
    expect(dup).toBeNull()
  })

  it('已 completed 的相同工具不命中(允许后续轮次重新执行)', () => {
    const tools = [
      { status: 'completed' as const, block: toolUse('call_1', 'bash', { command: 'git status' }) },
    ]
    const dup = findDuplicateTrackedTool(
      tools,
      toolUse('call_2', 'bash', { command: 'git status' }),
    )
    expect(dup).toBeNull()
  })
})
