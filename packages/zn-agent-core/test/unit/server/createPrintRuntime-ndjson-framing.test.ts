/**
 * createPrintRuntime — NDJSON 入向分帧回归测试
 *
 * 回归的 bug:`headlessPrintSession.writeLine` 曾用 `input.push(JSON.stringify(json))`
 * 推入不带换行的行。vendor `cli/structuredIO.ts` 的 `read()` 把每个 chunk 累加进
 * `content`,只有在找到 `'\n'` 时才切出一条消息并 yield;**没有换行的 chunk 会一直
 * 留在缓冲里,直到输入流关闭**才在收尾处被 flush。
 *
 * CLI 下这个缺陷不可见:`getStructuredIO` 把单条 prompt 包进 `fromArray`,流立刻关闭,
 * 收尾 flush 顶上了。但 in-process 轨道的输入队列在整个 session 生命周期里保持打开,
 * 于是 turn 永远不开始、session 零输出 —— 表现为「用 --runtime=print 启动后对话没有
 * 任何回复」。
 *
 * 已有的 contract / lifecycle / bridges 测试都用 `runHeadlessImpl` stub 逐行读队列
 * (`for await (const line of inputPrompt)` + 直接 `JSON.parse(line)`),对换行完全不
 * 敏感,所以全绿也测不到这条。本文件的 stub 刻意复刻 StructuredIO 的缓冲+切分语义,
 * 让分帧回归时 query 会挂起(测试超时)而不是静默通过。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OpenccRuntimeV2 } from '@zn-ai/zn-agent-core'
import { getPrintSessionContext } from '@zn-ai/zn-agent-core'

let dir: string
let runtime: OpenccRuntimeV2

/** 队列里实到的原始 chunk(未切分),用于直接断言分帧。 */
const rawChunks: string[] = []
/** 经 StructuredIO 同款切分后真正被「投递」的消息。 */
const delivered: Array<Record<string, unknown>> = []

function emitLine(obj: Record<string, unknown>): void {
  const ctx = getPrintSessionContext()
  ctx?.writeOutput(JSON.stringify(obj) + '\n')
}

/**
 * vendor `StructuredIO.read()`(cli/structuredIO.ts:213-251)的最小复刻:
 * 累加 chunk,只在遇到 '\n' 时切行。流关闭后的收尾 flush 故意**不实现** ——
 * in-process session 的队列不会在 turn 之间关闭,靠收尾 flush 就等于挂死。
 */
async function newlineFramedLoop(
  inputPrompt: string | AsyncIterable<string>,
): Promise<void> {
  let content = ''
  for await (const chunk of inputPrompt as AsyncIterable<string>) {
    rawChunks.push(chunk)
    content += chunk
    for (;;) {
      const nl = content.indexOf('\n')
      if (nl === -1) break
      const line = content.slice(0, nl)
      content = content.slice(nl + 1)
      if (line === '') continue
      const msg = JSON.parse(line) as Record<string, unknown>
      delivered.push(msg)
      if (msg.type === 'user') {
        emitLine({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'framed-ok',
          session_id: msg.session_id,
          uuid: randomUUID(),
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        })
      }
    }
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'print-framing-'))
  writeFileSync(join(dir, 'settings.json'), '{}')
  const { createPrintRuntime } = await import('@zn-ai/zn-agent-core')
  runtime = (await createPrintRuntime({
    dataDir: dir,
    runtimeId: 'framing-test',
    defaultCwd: dir,
    connectMcp: false,
    runHeadlessImpl: newlineFramedLoop as never,
  } as never)) as OpenccRuntimeV2
  // 顶层 hook 不受下面 describe 的 `{ timeout }` 覆盖,首次
  // import('@zn-ai/zn-agent-core') 的 vite-node transform 就要 ~7s。
}, 60_000)

afterAll(async () => {
  await runtime?.shutdown()
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

describe('createPrintRuntime — 入向 NDJSON 必须按行分帧', { timeout: 60_000 }, () => {
  it('user 消息在流保持打开时即被投递(不依赖收尾 flush)', async () => {
    rawChunks.length = 0
    delivered.length = 0
    const sid = randomUUID()
    const events: Array<Record<string, unknown>> = []
    // 分帧回归时这个 for-await 收不到任何事件也不会结束 → 撞 suite timeout。
    for await (const ev of runtime.query({
      sessionId: sid,
      prompt: 'framing probe',
      cwd: dir,
    })) {
      events.push(ev as unknown as Record<string, unknown>)
    }
    expect(delivered.some(m => m.type === 'user')).toBe(true)
    expect(events.length).toBeGreaterThan(0)
    // 每个 chunk 自身就是一条完整的、以换行收尾的 NDJSON 行。
    expect(rawChunks.length).toBeGreaterThan(0)
    for (const chunk of rawChunks) {
      expect(chunk.endsWith('\n')).toBe(true)
      expect(() => JSON.parse(chunk)).not.toThrow()
    }
  })

  it('sendInterrupt / end_session 等 control_request 走同一条分帧路径', async () => {
    rawChunks.length = 0
    delivered.length = 0
    const sid = randomUUID()
    for await (const _ev of runtime.query({
      sessionId: sid,
      prompt: 'probe before interrupt',
      cwd: dir,
    })) {
      void _ev
    }
    await runtime.interrupt(sid)
    // interrupt 是 fire-and-forget:轮询到它被投递为止(不靠固定 sleep)。
    const deadline = Date.now() + 5_000
    while (
      Date.now() < deadline &&
      !delivered.some(
        m =>
          m.type === 'control_request' &&
          (m.request as { subtype?: string } | undefined)?.subtype ===
            'interrupt',
      )
    ) {
      await new Promise(r => setImmediate(r))
    }
    expect(
      delivered.some(
        m =>
          m.type === 'control_request' &&
          (m.request as { subtype?: string } | undefined)?.subtype ===
            'interrupt',
      ),
    ).toBe(true)
    for (const chunk of rawChunks) {
      expect(chunk.endsWith('\n')).toBe(true)
    }
  })
})
