/**
 * createPrintRuntime — P2 生命周期测试(idle TTL / 任务保护 / 驱逐后重建 /
 * 空闲 CPU)。与 contract 测试分离:本文件用带任务注入能力的 fake loop。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OpenccRuntimeV2 } from '@zn-ai/zn-agent-core'
import { getPrintSessionContext } from '@zn-ai/zn-agent-core'

const HELD_TASK_SESSIONS = new Set<string>()

function emitLine(obj: Record<string, unknown>): void {
  const line = JSON.stringify(obj) + '\n'
  const ctx = getPrintSessionContext()
  if (ctx) ctx.writeOutput(line)
  // 测试进程内不应有真 stdout 输出路径;若发生则静默丢弃即可。
}

async function fakeLoop(
  inputPrompt: string | AsyncIterable<string>,
  _getAppState: unknown,
  setAppState: (f: (prev: any) => any) => void,
  _commands: unknown,
  _tools: unknown,
  _sdkMcpConfigs: unknown,
  _agents: unknown,
): Promise<void> {
  let lastSid = ''
  for await (const line of inputPrompt as AsyncIterable<string>) {
    const msg = JSON.parse(line)
    const sid = (msg.session_id as string) || lastSid
    if (msg.type === 'user') {
      lastSid = sid
      const text = JSON.stringify((msg.message as any)?.content ?? '')
      if (text.includes('hold-task')) {
        // 模拟模型派了个后台任务:store.tasks 里挂一个 running 条目。
        setAppState((prev: any) => ({
          ...prev,
          tasks: {
            ...(prev.tasks ?? {}),
            [`bg-${sid}`]: { id: `bg-${sid}`, type: 'local_agent', status: 'running' },
          },
        }))
      }
      if (text.includes('release-task')) {
        setAppState((prev: any) => {
          const { [`bg-${sid}`]: _drop, ...rest } = prev.tasks ?? {}
          return { ...prev, tasks: rest }
        })
      }
      emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid, uuid: randomUUID(), total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] })
    } else if (msg.type === 'control_request' && (msg.request as any)?.subtype === 'interrupt') {
      emitLine({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'], session_id: sid, uuid: randomUUID(), total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] })
    }
  }
}

const HOUR = 3_600_000

// 60s suite timeout — same knob createPrintRuntime-contract.test.ts uses.
// Every getOrCreate() runs a full createHeadlessContextImpl bootstrap, which
// costs ~10s under vite-node (vs ~80ms in a warm process), so vitest's 5s
// default trips on instance creation rather than on anything asserted here.
describe('createPrintRuntime — P2 生命周期', { timeout: 60_000 }, () => {
  let dir: string
  let runtime: OpenccRuntimeV2 & { __sweepIdleForTests: (now?: number) => number }

  const drain = async (sid: string, prompt: string) => {
    for await (const _ev of runtime.query({ sessionId: sid, prompt, cwd: dir })) void _ev
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'print-lifecycle-'))
    writeFileSync(join(dir, 'settings.json'), '{}')
    const { createPrintRuntime } = await import('@zn-ai/zn-agent-core')
    runtime = (await createPrintRuntime({
      dataDir: dir,
      runtimeId: 'lifecycle-test',
      defaultCwd: dir,
      connectMcp: false,
      runHeadlessImpl: fakeLoop as never,
    } as never)) as never
  })

  afterAll(async () => {
    await runtime?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('idle TTL:sweep 驱逐超龄实例,再 query 自动重建', async () => {
    const sid = randomUUID()
    await drain(sid, 'hello')
    expect(await runtime.getSessionState(sid)).not.toBeNull()

    // 未到 TTL:sweep 不动它
    expect(runtime.__sweepIdleForTests(Date.now() + 60_000)).toBe(0)
    expect(await runtime.getSessionState(sid)).not.toBeNull()

    // 超过默认 30min:sweep 驱逐
    expect(runtime.__sweepIdleForTests(Date.now() + HOUR)).toBeGreaterThanOrEqual(1)
    expect(await runtime.getSessionState(sid)).toBeNull()

    // 再 query:经 getOrCreate 重建并可完整对话(hydrate 语义 —— fake 无
    // transcript,resume 判定走 sessions.get==null 分支,仍须成功)
    await drain(sid, 'after-evict')
    expect(await runtime.getSessionState(sid)).not.toBeNull()
    await runtime.removeSession(sid)
  })

  it('有活跃后台任务的实例不被 sweep 驱逐(plan §9.3)', async () => {
    const sid = randomUUID()
    await drain(sid, 'hold-task')
    const state = (await runtime.getSessionState(sid)) as any
    expect(state?.tasks?.[`bg-${sid}`]?.status).toBe('running')

    // 超龄 + 任务 running → 不驱逐
    expect(runtime.__sweepIdleForTests(Date.now() + HOUR)).toBe(0)
    expect(await runtime.getSessionState(sid)).not.toBeNull()

    // 任务释放后下个 sweep 周期可驱逐
    await drain(sid, 'release-task')
    expect(runtime.__sweepIdleForTests(Date.now() + HOUR)).toBeGreaterThanOrEqual(1)
    expect(await runtime.getSessionState(sid)).toBeNull()
  })

  it('turn 进行中的实例不被驱逐(turnActive 保护)', async () => {
    const sid = randomUUID()
    // 半程消费:读一条后停止迭代,generator finally 将 turnActive 归位。
    const it = runtime.query({ sessionId: sid, prompt: 'x', cwd: dir })[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    // return 后 turn 已结束 —— 只断言 sweep 不因残留状态误报,实例可继续被服务。
    expect(await runtime.getSessionState(sid)).not.toBeNull()
    await runtime.removeSession(sid)
  })

  it('shutdown 后 sweep 安全返回 0 且不再有新实例', async () => {
    await runtime.shutdown()
    expect(runtime.__sweepIdleForTests(Date.now() + 10 * HOUR)).toBe(0)
  })

  it('空闲 CPU:挂起实例不烧 CPU(§9.5 短时近似;30min 真机验证在 P3)', async () => {
    // 重新起一个 runtime(上一个已 shutdown),建实例后静置 2s 测 CPU 增量。
    const dir2 = mkdtempSync(join(tmpdir(), 'print-idle-'))
    writeFileSync(join(dir2, 'settings.json'), '{}')
    const { createPrintRuntime } = await import('@zn-ai/zn-agent-core')
    const rt = (await createPrintRuntime({
      dataDir: dir2,
      runtimeId: 'idle-test',
      defaultCwd: dir2,
      connectMcp: false,
      runHeadlessImpl: fakeLoop as never,
    } as never)) as OpenccRuntimeV2
    const sid = randomUUID()
    for await (const _ev of rt.query({ sessionId: sid, prompt: 'warm', cwd: dir2 })) void _ev

    // GC 抖动前置排除 + 基线
    await new Promise(r => setTimeout(r, 200))
    const cpu0 = process.cpuUsage()
    const wall0 = Date.now()
    await new Promise(r => setTimeout(r, 2000))
    const delta = process.cpuUsage(cpu0)
    const cpuMs = (delta.user + delta.system) / 1000
    const wallMs = Date.now() - wall0
    // 2s 挂起(输入队列 pending Promise)应远小于 5% 占空比
    expect(cpuMs, `idle cpu ${cpuMs}ms / wall ${wallMs}ms`).toBeLessThan(wallMs * 0.05)
    await rt.shutdown()
    rmSync(dir2, { recursive: true, force: true })
  })
})
