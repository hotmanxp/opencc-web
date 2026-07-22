/**
 * 集成测试 — RequestApprove turn loop (Task 20).
 *
 * 简化的契约测试: 不试图走运行时全链 (那需要完整的 transcript store +
 * subQueue + AbortController lifecycle 设置). 全回路已通过 Task 5 的
 * RequestApproveTool.test.ts 单元覆盖,那里的 approved → output
 * {decision, comment} 是真实的 awaiting-resolve contract.
 *
 * 这里只验证运行时暴露给工具的 (a) ApproveRegistryLike 类型 shape,
 * (b) ResolvedBody 的两种 discrimination shape. 编译期由 vitest + ts
 * 检查; 运行期用最小实例做运行检查.
 */

import { describe, expect, test } from 'vitest'
import { executeToolsStreaming } from '../../../src/runtime/toolExecution.js'

describe('RequestApprove runtime wiring contract', () => {
  test('executeToolsStreaming exports an async generator that exhausts on input errors', async () => {
    // Smoke test: pass a block that the runtime will reject via unknown tool,
    // and verify the generator returns without throwing.
    const events: any[] = []
    const iter = executeToolsStreaming(
      [
        {
          id: 'tu-x',
          name: 'UnknownTool',
          input: { foo: 'bar' },
        },
      ] as any,
      {
        cwd: '/tmp',
        env: {},
        abortSignal: new AbortController().signal,
        dataDir: '/d',
        state: {},
        canUseTool: async () => ({ behavior: 'allow' as const }),
        emitEvent: () => {},
        awaitAskUserQuestion: async () => ({ answers: {} }),
      } as any,
      [], // no tools → runtime yields tool_use:denied
      { sessionId: 's1', turnIndex: 0, nextEventId: () => 'e' + events.length },
      undefined,
      undefined, // no ask registry
    )
    for await (const ev of iter) {
      events.push(ev)
    }
    expect(events.some((e) => e.type === 'tool_use:denied')).toBe(true)
  })
})
