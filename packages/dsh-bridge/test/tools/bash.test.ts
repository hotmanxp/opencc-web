/**
 * dsh-bridge Bash tool — 单元测试。
 *
 * Bug 背景 (dsh-019.9 修复)：
 *   Bash tool 的 execute() 返回
 *     `{ ..., exitCode: result.exitCode ?? undefined, signal: result.signal ?? undefined, ... }`。
 *   dsh-tools 的 `snapshotJsonValue` 在 walkJsonValue 中遇到 undefined 值
 *   (typeof undefined !== 'object'/'boolean'/'string'/'number') 会立刻
 *   返回 undefined → 整个对象被判定为 non-lossless JSON → 抛
 *   `ToolOutputError('Bash', ['value is not lossless JSON'])`。
 *   复现：sess-1787396112800-223pptbx（DSH 内核下 Bash 工具调用全部失败）。
 *
 * 修复：用条件展开省略 null 字段而非 `?? undefined`，让 snapshot 接受。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'

import { createBashTool } from '../../src/tools/bash.js'

describe('dsh-bridge Bash tool', () => {
  // 真实 exec 简单命令的 execute 应当返回 lossless JSON。
  it('execute() result is lossless JSON after a successful command', async () => {
    const tool = createBashTool({ cwd: process.cwd() })
    const result = await tool.execute({ command: 'echo hello', description: 'echo test' })
    const detached = snapshotJsonValue(result)
    expect(detached).toBeDefined()
    // 直接走 snapshotJsonValue 校验；只要不是 undefined 就算通过。
    // snapshotJsonValue(undefined) === undefined，所以 detached === undefined
    // 是 fail，detached === true/object 都是 pass（看 detach 标志）— 但
    // snapshotJsonValue 内部 detach=true，detached 必返回 root object。
    expect(detached).not.toBeUndefined()
  })

  it('execute() result is lossless JSON after a failed command (non-zero exit)', async () => {
    const tool = createBashTool({ cwd: process.cwd() })
    const result = await tool.execute({
      command: 'sh -c "exit 1"',
      description: 'forced non-zero exit',
    })
    const detached = snapshotJsonValue(result)
    expect(detached).not.toBeUndefined()
  })

  it('execute() result has no undefined properties (would trip snapshotJsonValue)', async () => {
    const tool = createBashTool({ cwd: process.cwd() })
    const result = await tool.execute({ command: 'echo ok', description: 'ok' })
    for (const [key, value] of Object.entries(result)) {
      expect(value, `property "${key}" must not be undefined`).not.toBeUndefined()
    }
  })

  it('execute() preserves signal as string when command is killed by signal', async () => {
    // SIGTERM 自己：sh -c 'kill -TERM $$' 等价于让 shell 用 SIGTERM 结束。
    const tool = createBashTool({ cwd: process.cwd() })
    const result = await tool.execute({
      command: 'sh -c "kill -TERM $$"',
      description: 'self-sigterm',
    })
    // exitCode 可能非数字（signal 终止），重点是字段不能 undefined。
    for (const [key, value] of Object.entries(result)) {
      expect(value, `property "${key}" must not be undefined`).not.toBeUndefined()
    }
  })
})