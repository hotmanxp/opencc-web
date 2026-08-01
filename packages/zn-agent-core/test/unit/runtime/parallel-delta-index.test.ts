/**
 * Parallel tool_use robustness — third layer.
 *
 * 背景: 前两层修复 (buildOpenccQueryParams.ts:319 用 `Map<number,string>` 分桶
 * `pendingToolInputJson`, agent.ts:122 用 `toolInputBuffers: Map<number,string>`
 * 分桶 input_json_delta) 解决了"两个 parallel tool_use 的 input 被 mash 到
 * 同一 string" 的问题. 但 `translateCallModel` 仍然依赖 `assistantContent[ev.index]`
 * 做 content_block_delta 的 lookup — 如果 proxy 发的事件 `ev.index` 缺失 /
 * 顺序错乱 / 复用, push 的位置和 lookup 的位置就会错位, input 仍然会被串错.
 *
 * 实测 (live repro 2026-08-01):
 *   正常的连续 idx=1, idx=2 路径工作正常 (turn 1 tool_use block 1+2 都拿到完整 input).
 *
 * 但代理实现可能存在 (三种 plausibility):
 *   A. proxy 不发 `ev.index` (omit 字段) — `assistantContent[undefined] === undefined`,
 *      block 拿不到 input_json_delta, content_block_stop 时 input 仍是 `{}` → 触发 throw.
 *   B. proxy 复用 idx=0 给两个 tool_use (Anthropic 协议不该这么干, 但 vendor
 *      toolOrchestration.ts:36 的并行 path 可能搞错): push 第一次到 [0], 第二次
 *      push 到 [1]; 但 deltas 都用 idx=0 → 全部写到 block[0] 上, block[1] 仍空.
 *   C. proxy 顺序错乱 (start/delta/stop 顺序乱序): 假设第二个 tool_use 的
 *      content_block_start 先到 idx=1, 然后第一个 tool_use 的 content_block_start
 *      idx=0. push 顺序与 idx 顺序反了. 现在 block[1] 是 tool_use #1, block[0]
 *      是 tool_use #2. 但 deltas 按 idx 走 → block[1] 收到 tool_use #1 的 input
 *      ✓, block[0] 收到 tool_use #2 的 input ✓ — 实际这种情况 push+lookup 仍然
 *      对齐, 因为 delta 也用同样的 idx lookup.
 *
 * 真正会出问题的 case 是 A + B: lookup 错位导致某 block 拿不到 input.
 *
 * 修复策略: 不再依赖 `assistantContent[ev.index]` 线性 lookup, 改用
 * `Map<tool_use.id, block>` keyed by cb.id. content_block_start 把 block 写入
 * map[cb.id]. content_block_delta 优先用 cb.id 在 delta 路径上 lookup (delta
 * 通常不带 cb.id, 仍用 idx fallback → block.id 匹配 idx). content_block_stop
 * 也走 cb.id lookup. message_stop 兜底遍历 map.
 *
 * 这些测试先把三种 case 都加进去, 然后实现 + 验证.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildOpenccQueryParams } from '../../../src/compat/runtime/buildOpenccQueryParams.js'
import type { QueryOptions } from '../../../src/compat/runtime/types.js'

const minimalOpts: QueryOptions = {
  prompt: { role: 'user', content: 'run both' },
  cwd: '/tmp',
  model: 'm',
  tools: [],
  sessionId: 's-parallel-delta-idx',
}

/**
 * Drive `deps.callModel` with a caller-supplied stream generator and
 * collect the opencc assistant messages it yields. Throws propagate.
 */
async function runStream(
  streamGen: () => AsyncGenerator<any>,
): Promise<any[]> {
  const modelCaller = vi.fn().mockReturnValue(streamGen())
  const params = await buildOpenccQueryParams(minimalOpts, {
    modelCaller: modelCaller as any,
  })
  const output: any[] = []
  for await (const message of params.deps!.callModel({
    messages: [{ role: 'user', content: 'run both' }],
    systemPrompt: '',
    tools: [],
    signal: new AbortController().signal,
    options: { model: 'm' },
  } as any) as AsyncIterable<any>) {
    output.push(message)
  }
  return output
}

describe('buildOpenccQueryParams — parallel tool_use delta/index robustness (third layer)', () => {
  it('A: proxy omits ev.index on content_block_delta → both blocks still parse correct input', async () => {
    // Proxy might omit `index` field on input_json_delta. assistantContent[undefined]
    // is undefined → block can't be looked up → input_json_delta silently dropped →
    // content_block_stop: tu.input === '{}' (default) → throws "empty input".
    //
    // Fix target: keep an alternative lookup keyed by cb.id stored on the block,
    // so even when ev.index is missing on a delta, we can route it to the right
    // open block.
    async function* stream() {
      yield { type: 'message_start', message: { id: 'm', model: 'm' } }
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu-A', name: 'Bash' },
      }
      // Delta WITHOUT index (simulates proxy bug).
      yield {
        type: 'content_block_delta',
        // no index
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ command: 'ls /etc/hostname' }),
        },
      }
      yield { type: 'content_block_stop', index: 0 }
      yield {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu-B', name: 'Bash' },
      }
      yield {
        type: 'content_block_delta',
        // no index
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ command: 'whoami' }),
        },
      }
      yield { type: 'content_block_stop', index: 1 }
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
      yield { type: 'message_stop' }
    }
    const out = await runStream(stream)
    const asst = out.find((m) => m?.type === 'assistant')
    expect(asst?.message?.content).toEqual([
      {
        type: 'tool_use',
        id: 'tu-A',
        name: 'Bash',
        input: { command: 'ls /etc/hostname' },
      },
      {
        type: 'tool_use',
        id: 'tu-B',
        name: 'Bash',
        input: { command: 'whoami' },
      },
    ])
  }, 15_000)

  it('B: proxy reuses idx=0 for both tool_use blocks → both blocks still parse correct input', async () => {
    // Anthropic SDK should never do this, but a buggy proxy might: send two
    // tool_use blocks both with `index: 0`. assistantContent.push adds them at
    // [0] and [1]; deltas use idx=0 lookup → only block[0] gets input → block[1]
    // stays empty → throws "empty input".
    //
    // Fix target: lookup by cb.id (last open tool_use block with matching id)
    // — even if both content_block_start use idx=0, we should track which
    // block is currently open by storing id on the push and looking it up by
    // matching cb.id on stop.
    async function* stream() {
      yield { type: 'message_start', message: { id: 'm', model: 'm' } }
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu-A', name: 'Bash' },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ command: 'ls /etc/hostname' }),
        },
      }
      yield { type: 'content_block_stop', index: 0 }
      yield {
        type: 'content_block_start',
        index: 0, // bug: should be 1
        content_block: { type: 'tool_use', id: 'tu-B', name: 'Bash' },
      }
      yield {
        type: 'content_block_delta',
        index: 0, // bug: stuck on 0
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ command: 'whoami' }),
        },
      }
      yield { type: 'content_block_stop', index: 0 } // bug: still 0
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
      yield { type: 'message_stop' }
    }
    const out = await runStream(stream)
    const asst = out.find((m) => m?.type === 'assistant')
    // Both blocks should still have valid distinct input.
    expect(asst?.message?.content).toHaveLength(2)
    const inputs = asst?.message?.content?.map((b: any) => b.input) ?? []
    expect(inputs).toContainEqual({ command: 'ls /etc/hostname' })
    expect(inputs).toContainEqual({ command: 'whoami' })
  }, 15_000)

  it('C: out-of-order content_block_start indices → both blocks still parse correct input', async () => {
    // Proxy might deliver content_block_start in different order from
    // content_block_stop. assistantContent[ev.index] lookup may misalign.
    // Fix target: block identity comes from cb.id; order doesn't matter.
    async function* stream() {
      yield { type: 'message_start', message: { id: 'm', model: 'm' } }
      yield {
        type: 'content_block_start',
        index: 1, // arrives second
        content_block: { type: 'tool_use', id: 'tu-B', name: 'Bash' },
      }
      yield {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ command: 'whoami' }),
        },
      }
      yield { type: 'content_block_stop', index: 1 }
      yield {
        type: 'content_block_start',
        index: 0, // arrives first in idx
        content_block: { type: 'tool_use', id: 'tu-A', name: 'Bash' },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ command: 'ls /etc/hostname' }),
        },
      }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
      yield { type: 'message_stop' }
    }
    const out = await runStream(stream)
    const asst = out.find((m) => m?.type === 'assistant')
    expect(asst?.message?.content).toHaveLength(2)
    const inputs = asst?.message?.content?.map((b: any) => b.input) ?? []
    expect(inputs).toContainEqual({ command: 'ls /etc/hostname' })
    expect(inputs).toContainEqual({ command: 'whoami' })
  }, 15_000)

  it('normal case: sequential idx=0, idx=1 with valid input_json_deltas → both blocks parsed', async () => {
    // Sanity check: the path that works in production must keep working
    // after the fix. Live repro 2026-08-01 confirmed this case works.
    async function* stream() {
      yield { type: 'message_start', message: { id: 'm', model: 'm' } }
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu-A', name: 'Bash' },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ command: 'ls /etc/hostname' }),
        },
      }
      yield { type: 'content_block_stop', index: 0 }
      yield {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu-B', name: 'Bash' },
      }
      yield {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ command: 'whoami' }),
        },
      }
      yield { type: 'content_block_stop', index: 1 }
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
      yield { type: 'message_stop' }
    }
    const out = await runStream(stream)
    const asst = out.find((m) => m?.type === 'assistant')
    expect(asst?.message?.content).toEqual([
      {
        type: 'tool_use',
        id: 'tu-A',
        name: 'Bash',
        input: { command: 'ls /etc/hostname' },
      },
      {
        type: 'tool_use',
        id: 'tu-B',
        name: 'Bash',
        input: { command: 'whoami' },
      },
    ])
  }, 15_000)
})