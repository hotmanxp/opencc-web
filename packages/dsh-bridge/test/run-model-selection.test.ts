import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createDshRuntime, type DshProviderProfile } from '../src/createDshRuntime.js'
import { runOnce } from '../src/run.js'
import { createModelSelectionRef } from '../src/model.js'

/**
 * ds-021 hotfix 端到端守护:runOnce 把 `modelSelection` 透传到
 * `agents.create({ setup })`,并在 agent scope 内 activate 上游
 * installModelSelection listener。
 *
 * 注意:这是 bridge 层契约测试 — 验证 dsh-bridge.runOnce 正确把 ref
 * 传给 setup 回调(让 setup 能 `upstreamInstallModelSelection(agentCtx,
 * modelSelection)`)。listener 的具体行为由上游
 * `installModelSelection` 守护(见 model-selection.test.ts)。
 *
 * 装载侧使用最小 mock:fake provider profile 满足 DshProviderProfile
 * schema,LLM 实际请求会被 dsh-llm-pi-ai 的 mock-friendly 行为捕获
 * (test 不实际 call LLM,只验证 setup 路径生效)。
 */
describe('runOnce() modelSelection 透传(ds-021 端到端)', () => {
  const tmpDataDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-runsms-'))
  const provider: DshProviderProfile = {
    name: 'anthropic',
    baseURL: 'https://api.example.com/anthropic',
    apiKeyEnv: 'TEST_API_KEY',
    defaultReasoningEffort: 'off',
    models: ['fake-model'],
  }

  it('setup 回调被传 modelSelection 时 installModelSelection 监听器注册成功', async () => {
    process.env.TEST_API_KEY = 'test-key'

    const handle = await createDshRuntime({
      dataDir: tmpDataDir,
      runtimeId: 'run-model-selection-test',
      defaultCwd: tmpDataDir,
      defaultModel: 'fake-model',
      providers: [provider],
    })
    await handle.start()

    try {
      // 关键:zai-side 把 model selection 注入到 runOnce opts →
      // runOnce 内部把它传给 agents.create({ setup }) → setup 回调
      // 调 installModelSelection(agentCtx, ref)
      const ref = createModelSelectionRef({ provider: 'anthropic', model: 'fake-model' })
      const sessionId = 'test-session-1'

      // 跑一个 quick turn,期间 intercept agents.create 的 setup 调用,
      // 验证它能跑过(说明 ref 被识别)。完整 LLM call 不会发生,因为
      // 没有 provider 响应 — 这测试的是 setup 路径而不是 LLM 内容。
      let setupInvoked = false
      // 通过包装 agents.create 进 hook 是侵入式的;更简单的方法是让 runOnce
      // 触发 cold create,断信 `agents.get(sessionId)` 没有 → 走 create →
      // setup 被 invoke 因为 ref 合法。
      const events = runOnce({
        ctx: handle.ctx,
        sessionId,
        cwd: tmpDataDir,
        prompt: 'hello',
        provider: 'anthropic',
        model: 'fake-model',
        modelSelection: ref,
        streamingIdleTimeoutMs: 5000,
      })

      // runOnce 是 AsyncIterable;尝试 drain 几个事件(setup throw → 立即退出;
      // setup 成功但 LLM mock 缺失 → turn/end 不会来,会触发 safety timeout)。
      // 我们只 drain 到第一个事件(或 safety timeout),不论哪种,都已经验证:
      //   - setup 拿到了 ref(没有 throw)
      //   - installModelSelection 在 agentCtx 上注册成功(否则后续会 throw)
      let drainedAny = false
      try {
        for await (const _e of events) {
          drainedAny = true
          break // 第一个事件就跳
        }
      } catch (err) {
        // 也可接受:drain 时如果 dsh 内部抛错(比如 prompt assembly 需要
        // SystemPrompt 等上游 service 全部就绪、setup 抛错),test 仍通过 —
        // 我们的目标是 setup 入参含 modelSelection 时不挂掉。
        if (process.env.ZAI_DEBUG === '1') {
          console.warn('[dsh-bridge:test] runOnce drain err:', err instanceof Error ? err.message : err)
        }
      }

      // ref.current 是 zai-side 持有 — runOnce 不应清掉。
      expect(ref.current).toEqual({ provider: 'anthropic', model: 'fake-model' })
      // ref.assembled 在 agent loop 启动后会被 system-prompt/assemble
      // 阶段 snapshot ref.current(上游 installModelSelection 行为)。
      // **这是 ds-021 真接线的活证据** — 不再是 undefined 就是 setup
      // 真的调过 installModelSelection。
      expect(ref.assembled).toEqual({ provider: 'anthropic', model: 'fake-model' })

      // agent 已经注册到 ctx.agents
      const agents = handle.ctx.get('agents') as {
        get?: (id: unknown) => { session?: { append?: (t: string, d: unknown) => unknown } } | undefined
      } | undefined
      const agent = agents?.get?.(sessionId)
      setupInvoked = agent !== undefined

      expect(setupInvoked).toBe(true)
    } finally {
      await handle.shutdown()
    }
  }, 60_000)

  it('不传 modelSelection 时不报错(行为兼容旧版本)', async () => {
    process.env.TEST_API_KEY = 'test-key'

    const handle = await createDshRuntime({
      dataDir: tmpDataDir,
      runtimeId: 'run-model-selection-test-noop',
      defaultCwd: tmpDataDir,
      defaultModel: 'fake-model',
      providers: [provider],
    })
    await handle.start()

    try {
      const events = runOnce({
        ctx: handle.ctx,
        sessionId: 'test-session-2',
        cwd: tmpDataDir,
        prompt: 'hello',
        provider: 'anthropic',
        model: 'fake-model',
        // 故意不传 modelSelection
        streamingIdleTimeoutMs: 5000,
      })

      try {
        // drain 到第一个事件或 timeout
        for await (const _e of events) {
          break
        }
      } catch {
        // 同上
      }

      // agent 仍被创建
      const agents = handle.ctx.get('agents') as {
        get?: (id: unknown) => { session?: unknown } | undefined
      } | undefined
      const agent = agents?.get?.('test-session-2')
      expect(agent).toBeDefined()
    } finally {
      await handle.shutdown()
    }
  }, 60_000)

  it('清理临时 dataDir', () => {
    rmSync(tmpDataDir, { recursive: true, force: true })
  })
})
