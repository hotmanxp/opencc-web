// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P3): ReplRuntime slash command routing.
 * Verifies /-prefixed prompts route to stub handlers emitting
 * runtime.notification + runtime.done, NEVER runtime.error.
 * Non-slash prompts pass through unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ReplRuntime } from '../agentRuntime.repl.js'

describe('ReplRuntime slash command routing', () => {
  let runtime: ReplRuntime

  beforeEach(() => {
    runtime = new ReplRuntime()
  })

  afterEach(async () => {
    await runtime.shutdown()
  })

  it('/loop yields loop-scheduled notification + done', async () => {
    const events: any[] = []
    const sessionId = `s-${Date.now()}`
    for await (const ev of runtime.query({ sessionId, prompt: '/loop 30s "ping"' })) {
      events.push(ev)
    }
    const notifications = events.filter((e) => e.type === 'runtime.notification')
    expect(notifications.some((n: any) => n.kind === 'loop-scheduled')).toBe(true)
    expect(events.some((e) => e.type === 'runtime.done')).toBe(true)
  })

  it('/swarm yields swarm-scheduled notification + done', async () => {
    const events: any[] = []
    const sessionId = `s-${Date.now()}`
    for await (const ev of runtime.query({ sessionId, prompt: '/swarm create teammate1' })) {
      events.push(ev)
    }
    expect(events.some((e: any) => e.kind === 'swarm-scheduled')).toBe(true)
    expect(events.some((e) => e.type === 'runtime.done')).toBe(true)
  })

  it('/send yields send-scheduled notification + done', async () => {
    const events: any[] = []
    const sessionId = `s-${Date.now()}`
    for await (const ev of runtime.query({ sessionId, prompt: '/send sess-123 "hello"' })) {
      events.push(ev)
    }
    expect(events.some((e: any) => e.kind === 'send-scheduled')).toBe(true)
    expect(events.some((e) => e.type === 'runtime.done')).toBe(true)
  })

  it('unknown slash command 不再被 stub 吞掉:委托 OpenccRuntime', async () => {
    const delegated: any[] = []
    const fakeRuntime = {
      async *query(input: any) {
        delegated.push(input)
        yield { type: 'runtime.done', sessionId: input.sessionId, turnIndex: 0, apiRequestCount: 0 }
      },
    } as any
    const rt = new ReplRuntime(fakeRuntime)
    try {
      const events: any[] = []
      for await (const ev of rt.query({ sessionId: 's-unknown', prompt: '/foo bar' })) {
        events.push(ev)
      }
      expect(delegated.map((i) => i.prompt)).toEqual(['/foo bar'])
      expect(events.some((e: any) => e.kind === 'unknown-command')).toBe(false)
      expect(events.some((e: any) => e.type === 'runtime.notification')).toBe(false)
      expect(events.some((e) => e.type === 'runtime.done')).toBe(true)
    } finally {
      await rt.shutdown()
    }
  })

  // 回归: 以绝对路径开头的普通提问(`/Users/x/y.md 这个文件内容是什么`)曾被
  // parseSlashCommand 判成未知命令 → notification + done 直接 return,消息
  // 静默消失(不落盘/不调模型/不报错),前端只剩一个用户气泡。
  it('绝对路径开头的提问走正常 turn,不被当成 slash 命令吞掉', async () => {
    const delegated: any[] = []
    const fakeRuntime = {
      async *query(input: any) {
        delegated.push(input)
        yield { type: 'runtime.done', sessionId: input.sessionId, turnIndex: 0, apiRequestCount: 0 }
      },
    } as any
    const rt = new ReplRuntime(fakeRuntime)
    try {
      const prompt = '/Users/liangxuechao572/code/zn-ai-zbuddy/FIX_REPORT.md 这个文件内容是什么'
      const events: any[] = []
      for await (const ev of rt.query({ sessionId: 's-path', prompt })) {
        events.push(ev)
      }
      expect(delegated.map((i) => i.prompt)).toEqual([prompt])
      expect(events.some((e: any) => e.kind === 'unknown-command')).toBe(false)
    } finally {
      await rt.shutdown()
    }
  })

  // 单段路径(`/tmp 里有什么`)首个 token 只含 [A-Za-z0-9],「字符集判据」挡不住;
  // 白名单判据能挡住 —— 它必须走进正常 turn。
  it('单段绝对路径开头(如 /tmp)同样委托正常 turn', async () => {
    const delegated: any[] = []
    const fakeRuntime = {
      async *query(input: any) {
        delegated.push(input)
        yield { type: 'runtime.done', sessionId: input.sessionId, turnIndex: 0, apiRequestCount: 0 }
      },
    } as any
    const rt = new ReplRuntime(fakeRuntime)
    try {
      for await (const _ev of rt.query({ sessionId: 's-tmp', prompt: '/tmp 里有什么文件' })) {
        /* drain */
      }
      expect(delegated.map((i) => i.prompt)).toEqual(['/tmp 里有什么文件'])
    } finally {
      await rt.shutdown()
    }
  })

  it('non-slash prompt does NOT trigger slash routing', async () => {
    const events: any[] = []
    const sessionId = `s-${Date.now()}`
    for await (const ev of runtime.query({ sessionId, prompt: 'hello there' })) {
      events.push(ev)
    }
    const notifications = events.filter((e: any) => e.kind === 'loop-scheduled' || e.kind === 'swarm-scheduled' || e.kind === 'send-scheduled' || e.kind === 'unknown-command')
    expect(notifications).toHaveLength(0)
  })
})
