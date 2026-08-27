/**
 * createPrintRuntime — P1 契约测试。
 *
 * 用注入的 `runHeadlessImpl` stub 模拟 vendor print 循环(NDJSON in/out),
 * 不打真实模型、不需要 API key。覆盖:
 *   - OpenccRuntimeV2 形状(8 V1 方法 + enqueue/interrupt/getSessionState + plugins)
 *   - query 回合:sendUserMessage → stub 回声 → translateSdkToRuntime 出口
 *   - per-session 隔离:两 sessionId 各自 store,permissionMode 互不串
 *   - enqueue/interrupt 路由到正确实例
 *   - removeSession / shutdown 的 dispose 语义
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type {
  OpenccEnqueueInput,
  OpenccRuntimeV2,
} from '@zn-ai/zn-agent-core'
// 关键:必须从 bundle 主入口拿 ALS context(fake 与 createPrintRuntime 同
// 模块实例);从 src 源码 import 会得到另一份 AsyncLocalStorage 实例,
// sink 路由不通。
import { getPrintSessionContext } from '@zn-ai/zn-agent-core'

/** 输出 NDJSON 行:会话内走 ALS sink(与真 runHeadless 的 writeToStdout 同语义)。 */
function emitLine(obj: Record<string, unknown>): void {
  const line = JSON.stringify(obj) + '\n'
  const ctx = getPrintSessionContext()
  if (ctx) ctx.writeOutput(line)
  else process.stdout.write(line)
}

/** 收到的每行输入(NDJSON 已 parse),测试断言路由用。 */
const seenInput: Record<string, Array<Record<string, unknown>>> = {}

/**
 * runHeadless 的测试替身:消费 input NDJSON 行 ——
 *   user → 回声 assistant + result(经 ALS sink 回到 query)
 *   control_request{interrupt} → 当前回合 result(is_error)收尾
 * 行为刻意保持与 vendor stream-json 词汇一致。
 */
async function fakeRunHeadless(
  inputPrompt: string | AsyncIterable<string>,
  _getAppState: unknown,
  _setAppState: unknown,
  _commands: unknown,
  _tools: unknown,
  _sdkMcpConfigs: unknown,
  _agents: unknown,
  options: { resume?: string | boolean },
): Promise<void> {
  // options.resume 即 sessionId(createPrintRuntime 对已存在会话传 sid);
  // 新会话时用 store 里的 sessionId —— 由 ALS 提供,fake 拿不到,
  // 因此回退到最近一次未见过的注册表。为测试简单:fake 按 user 消息里
  // 的 session_id 字段分流(zai sid 直接透传在 sendUserMessage)。
  let activeTurn: { sessionId: string; userUuid: string } | null = null
  let lastSid = String(options.resume ?? '')
  const sidOf = () => activeTurn?.sessionId ?? lastSid
  for await (const line of inputPrompt as AsyncIterable<string>) {
    const msg = JSON.parse(line)
    const sid = (msg.session_id as string) || sidOf()
    if (msg.type === 'user') lastSid = sid
    ;(seenInput[sid] ??= []).push(msg)
    if (msg.type === 'user') {
      activeTurn = { sessionId: sid, userUuid: msg.uuid }
      emitLine({
          type: 'system',
          subtype: 'init',
          session_id: sid,
          uuid: randomUUID(),
        })
      emitLine({
          type: 'assistant',
          session_id: sid,
          uuid: randomUUID(),
          message: {
            id: randomUUID(),
            role: 'assistant',
            model: 'fake',
            content: [{ type: 'text', text: `echo:${sid}` }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        })
      // 真 print 每回合以 result 收尾 —— query 消费循环靠它 break。
      emitLine({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: `echo:${sid}`,
        session_id: sid,
        uuid: randomUUID(),
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
      })
      activeTurn = null
    } else if (msg.type === 'control_request') {
      if (msg.request?.subtype === 'interrupt') {
        emitLine({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['interrupted'],
            session_id: sid,
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

function collectPrompt(msg: Record<string, unknown>): string {
  const content = (msg.message as { content: unknown }).content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

/** poll 直到 fake 循环消费了对应输入行(入队即返回,消费是异步的)。 */
async function waitForLine(
  sid: string,
  pred: (m: Record<string, unknown>) => boolean,
  what: string,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const lines = seenInput[sid] ?? []
    if (lines.some(pred)) return lines
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('createPrintRuntime — P1 契约', { timeout: 60_000 }, () => {
  let dir: string
  let runtime: OpenccRuntimeV2

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'print-runtime-'))
    writeFileSync(join(dir, 'settings.json'), '{}')
    const { createPrintRuntime } = await import('@zn-ai/zn-agent-core')
    runtime = await createPrintRuntime({
      dataDir: dir,
      runtimeId: 'test',
      defaultCwd: dir,
      connectMcp: false,
      runHeadlessImpl: fakeRunHeadless as never,
    } as never)
  })

  afterAll(async () => {
    await runtime?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('V2 形状:8 V1 方法 + enqueue/interrupt/getSessionState + plugins', () => {
    for (const m of [
      'query',
      'abort',
      'getSession',
      'listSessions',
      'readTranscript',
      'patchSession',
      'removeSession',
      'shutdown',
      'enqueue',
      'interrupt',
      'getSessionState',
    ] as const) {
      expect(typeof (runtime as any)[m], m).toBe('function')
    }
    expect(typeof runtime.plugins.listInstalled).toBe('function')
  })

  it('query 端到端:prompt 进、翻译后的事件流回、result 收束', async () => {
    const sid = randomUUID()
    const events: Array<Record<string, unknown>> = []
    for await (const ev of runtime.query({
      sessionId: sid,
      prompt: 'hello',
      cwd: dir,
    })) {
      events.push(ev as unknown as Record<string, unknown>)
    }
    // 输入路由到实例
    expect(seenInput[sid]?.some(m => m.type === 'user' && collectPrompt(m).includes('hello'))).toBe(true)
    // 出口含翻译后的原语(assistant 内容经 translateSdkToRuntime)
    const types = events.map(e => e.type)
    expect(types).toContain('message_start')
    expect(JSON.stringify(events)).toContain('echo:')
    // 事件都带 sessionId
    expect(events.every(e => e.sessionId === sid)).toBe(true)
  })

  it('per-session 隔离:两个 session 各自 store,permissionMode 不串', async () => {
    const a = randomUUID()
    const b = randomUUID()
    const consume = (sid: string) =>
      new Promise<void>(async resolve => {
        for await (const _ev of runtime.query({ sessionId: sid, prompt: 'x', cwd: dir })) void _ev
        resolve()
      })
    await Promise.all([consume(a), consume(b)])

    const stateA = await runtime.getSessionState(a)
    const stateB = await runtime.getSessionState(b)
    expect(stateA).not.toBeNull()
    expect(stateB).not.toBeNull()
    // 不同 store 实例
    expect(stateA).not.toBe(stateB)

    // A 切 plan 模式,B 不受影响(对照:轻量 track 共享 ctx.appState 会串)
    for await (const _ev of runtime.query({
      sessionId: a,
      prompt: 'plan me',
      cwd: dir,
      permissionMode: 'plan',
    })) void _ev
    const modeA = (await runtime.getSessionState(a) as any)?.toolPermissionContext?.mode
    const modeB = (await runtime.getSessionState(b) as any)?.toolPermissionContext?.mode
    expect(modeA).toBe('plan')
    expect(modeB).not.toBe('plan')

    await runtime.removeSession(a)
    await runtime.removeSession(b)
    expect(await runtime.getSessionState(a)).toBeNull()
    expect(await runtime.getSessionState(b)).toBeNull()
  })

  it('enqueue 注入活实例(带 priority),interrupt 触达 control_request', async () => {
    const sid = randomUUID()
    const queryPromise = (async () => {
      const out: Array<Record<string, unknown>> = []
      for await (const ev of runtime.query({ sessionId: sid, prompt: 'first', cwd: dir }))
        out.push(ev as unknown as Record<string, unknown>)
      return out
    })()
    // 等 query 完成第一轮
    await queryPromise

    const input: OpenccEnqueueInput = {
      sessionId: sid,
      prompt: 'steer me',
      priority: 'now',
    }
    await runtime.enqueue(input)
    await waitForLine(
      sid,
      m => m.type === 'user' && collectPrompt(m).includes('steer me'),
      'steer user message',
    )
    const lines = seenInput[sid] ?? []
    const steer = lines.filter(m => m.type === 'user' && collectPrompt(m).includes('steer me'))
    expect(steer.length).toBe(1)
    expect(steer[0].priority).toBe('now')

    await runtime.interrupt(sid)
    const linesAfterInterrupt = await waitForLine(
      sid,
      m => m.type === 'control_request' && (m.request as any)?.subtype === 'interrupt',
      'interrupt control_request',
    )
    const interrupts = linesAfterInterrupt.filter(
      m => m.type === 'control_request' && (m.request as any)?.subtype === 'interrupt',
    )
    expect(interrupts.length).toBe(1)
    expect(await runtime.getSessionState(sid)).not.toBeNull()
    await runtime.removeSession(sid)
  })

  it('abort() 与 interrupt() 同语义(interrupt control_request)', async () => {
    const sid = randomUUID()
    for await (const _ev of runtime.query({ sessionId: sid, prompt: 'hi', cwd: dir })) void _ev
    await runtime.abort(sid)
    const lines = await waitForLine(
      sid,
      m => m.type === 'control_request' && (m.request as any)?.subtype === 'interrupt',
      'abort→interrupt',
    )
    expect(
      lines.some(
        m => m.type === 'control_request' && (m.request as any)?.subtype === 'interrupt',
      ),
    ).toBe(true)
    await runtime.removeSession(sid)
  })

  it('shutdown 清空全部实例', async () => {
    const sid = randomUUID()
    for await (const _ev of runtime.query({ sessionId: sid, prompt: 'x', cwd: dir })) void _ev
    expect(await runtime.getSessionState(sid)).not.toBeNull()
    await runtime.shutdown()
    expect(await runtime.getSessionState(sid)).toBeNull()
    // shutdown 后再 query 必须明确报错
    await expect(
      (async () => {
        for await (const _ of runtime.query({ sessionId: sid, prompt: 'x', cwd: dir })) void _
      })(),
    ).rejects.toThrow(/shut ?down/i)
  })
})
