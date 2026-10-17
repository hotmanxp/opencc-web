/**
 * 回归测试 — send_message 对 **running** 任务必须真的送达,或明确拒绝 (wb-007)。
 *
 * 缺陷:`taskInbox` 全文件只有 4 处引用,唯一的 delete 在 `runOne` 开头
 * (`:542/:550`),而 `runOne` 只由 `scheduleNext` 从 queue 取**新 id** 调用。
 * 于是已经 running 的任务永远不会再读一次 inbox:
 *   - `sendMessageToTask` 照样返回 `{ok:true}`(骗调用方说成功)
 *   - prompt 永久滞留,直到任务自然结束才被丢弃
 * 而 `interrupt_agent` 落终态后 `sendMessageToTask` 恒返 `ok:false` ——
 * 工具描述与实际语义相反。
 *
 * 既有 `sendMessageToTask.test.ts` 里那条「消费后 queue 清空」用例恰好
 * **绕开了**这个问题:它的注释写着「fake agent 已在等 abort,query 不会再
 * 触发;这个测试只验证 taskInbox 重新入队的接口语义,不强求 query 再次
 * capture」。也就是说它验的是接口返回值,不是**送达**。本文件验送达。
 *
 * 修法取计划书的方案 ①:running 任务在 turn 边界消费 inbox(而不是把
 * running 的返回从 ok:true 改成拒绝 —— 那会让 subagent 中途改向彻底不可用)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DefaultBackgroundRuntime,
  JsonTaskStore,
} from '../../../src/compat/background/index.js'

interface CapturedQueryInput {
  prompt: string
}

/**
 * fake agent:第一轮流式产出后**自然结束**(generator return),让 runtime
 * 走到 turn 边界 —— 那正是 wb-007 修复要挂钩的位置。后续每轮同样自然结束。
 *
 * 刻意不做「永远挂住」:那样永远到不了 turn 边界,测的就不是修复点。
 * 用一个 `holdFirstTurn` 开关控制首轮是否挂住,供「投递发生在 running 期」
 * 的用例使用(投递之后手动 release,让首轮结束并进入下一轮)。
 */
function makeTurnAgent(captured: CapturedQueryInput[]) {
  const waiters: Array<() => void> = []
  let holdFirstTurn = true
  return {
    agent: {
      async *query(input: { prompt?: string; abortSignal?: AbortSignal }) {
        captured.push({ prompt: input.prompt ?? '' })
        const isFirst = captured.length === 1
        if (isFirst && holdFirstTurn) {
          // 首轮挂住 —— 制造「任务处于 running,父 agent 此刻投递」的时序
          await new Promise<void>((resolve) => { waiters.push(resolve) })
        } else {
          // 产出一点内容后自然结束 → runtime 到达 turn 边界
          yield { type: 'content_block_delta', eventId: 'd', ts: Date.now(), delta: { type: 'text_delta', text: 'ok' } }
          yield { type: 'message_stop', eventId: 's', ts: Date.now() }
        }
        if (input.abortSignal?.aborted) return
      },
    },
    release() {
      holdFirstTurn = false
      for (const w of waiters.splice(0)) w()
    },
  }
}

let tmpDir: string
let store: JsonTaskStore
let captured: CapturedQueryInput[]
let runtime: DefaultBackgroundRuntime
let releaseFirstTurn: () => void

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bg-deliver-'))
  store = new JsonTaskStore(tmpDir)
  await store.ensureDirs()
  captured = []
  const turn = makeTurnAgent(captured)
  releaseFirstTurn = turn.release
  runtime = new DefaultBackgroundRuntime({
    maxConcurrent: 1,
    store,
    agentRuntime: turn.agent as never,
  } as never)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('waitFor timed out')
}

describe('sendMessageToTask — running 任务的送达 (wb-007)', () => {
  it('running 期间投递的消息必须进入下一轮 turn,而不是永久滞留', async () => {
    const a = await runtime.dispatch({
      prompt: 'original',
      metadata: { parentSessionId: 'sess-1' },
    })
    // 等到任务真的 running 且第一轮 query 已经 capture
    await waitFor(() => captured.length >= 1)

    // 此刻任务正 running(第一轮 query 挂着)—— 发一条改向指令
    const res = await runtime.sendMessageToTask(a.id, 'change direction')
    expect(res.ok, '接口应接受投递').toBe(true)

    // 此刻首轮还挂着(任务 running)。放它结束 → 到达 turn 边界,
    // 修复后的逻辑应当在这里看到 inbox 非空并起下一轮。
    releaseFirstTurn()

    // 关键断言:这条消息必须出现在**后续某轮** query 的 prompt 里。
    // 修复前:inbox 只在 runOne 开头被读一次,running 期间再投的消息
    // 永远不被消费 —— captured 停在 1 条。
    await waitFor(
      () => captured.some((c) => c.prompt.includes('change direction')),
      3000,
    )
    const turn = captured.find((c) => c.prompt.includes('change direction'))!
    expect(turn.prompt).toContain('change direction')
    expect(turn.prompt).toContain('original')

    await runtime.cancel(a.id)
  })

  it('多条 running 期消息按入队顺序全部送达,不丢不乱序', async () => {
    const a = await runtime.dispatch({
      prompt: 'base',
      metadata: { parentSessionId: 'sess-1' },
    })
    await waitFor(() => captured.length >= 1)

    await runtime.sendMessageToTask(a.id, 'msg-1')
    await runtime.sendMessageToTask(a.id, 'msg-2')
    await runtime.sendMessageToTask(a.id, 'msg-3')

    releaseFirstTurn()
    await waitFor(() => captured.some((c) => c.prompt.includes('msg-3')), 3000)
    const turn = captured.find((c) => c.prompt.includes('msg-3'))!
    expect(turn.prompt).toContain('msg-1')
    expect(turn.prompt).toContain('msg-2')
    // 顺序保持(入队顺序)
    expect(turn.prompt.indexOf('msg-1')).toBeLessThan(turn.prompt.indexOf('msg-2'))
    expect(turn.prompt.indexOf('msg-2')).toBeLessThan(turn.prompt.indexOf('msg-3'))

    await runtime.cancel(a.id)
  })

  it('终态任务投递仍返回 ok:false(既有语义不得回归)', async () => {
    const a = await runtime.dispatch({
      prompt: 'x',
      metadata: { parentSessionId: 'sess-1' },
    })
    await waitFor(() => captured.length >= 1)
    releaseFirstTurn()
    await runtime.cancel(a.id)
    // 等状态真正落到终态再断言 —— 否则测的是「cancel 还没生效」的中间态,
    // 那不是这条用例要守的东西。
    await waitFor(async () => (await runtime.get(a.id))?.status === 'cancelled').catch(() => {})
    await new Promise((r) => setTimeout(r, 60))
    const status = (await runtime.get(a.id))?.status
    expect(status, '任务应已到终态,否则本用例无意义').not.toBe('running')
    const res = await runtime.sendMessageToTask(a.id, 'after cancel')
    expect(res).toEqual({ ok: false })
  })
})
