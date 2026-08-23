import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createDshRuntime, type DshProviderProfile } from '../src/createDshRuntime.js'

/**
 * Phase 5P1: createDshRuntime 真装载 smoke test — 在 vitest 里完整跑一次
 * 装载流程（cordis-plugin-loader 装载 patch + 装载 50+ dsh-* 服务），
 * 让 Phase 1 之后的 zsh 装载路径在每次 typecheck/test 时被覆盖。
 *
 * 不实际跑 LLM call — 装载完成 + 关闭 ctx 即视为成功。
 *
 * 注意：mock 不需要 — createDshRuntime 装载不调 LLM,只要 settings 有
 * provider profile 就能完成。
 */
describe('createDshRuntime 装载 smoke (Phase 5P1)', () => {
  const tmpDataDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-smoke-'))

  const provider: DshProviderProfile = {
    name: 'anthropic',
    baseURL: 'https://api.example.com/anthropic',
    apiKeyEnv: 'TEST_API_KEY',
    defaultReasoningEffort: 'off',
    models: ['fake-model'],
  }

  it('装载 + 关闭 — 验证 Phase 5P1 装载面无报错', async () => {
    process.env.TEST_API_KEY = 'test-key'

    const handle = await createDshRuntime({
      dataDir: tmpDataDir,
      runtimeId: 'smoke-test',
      defaultCwd: tmpDataDir,
      defaultModel: 'fake-model',
      providers: [provider],
    })

    expect(handle.kernel).toBe('dsh')
    expect(handle.ctx).toBeDefined()
    expect(handle.activeCount()).toBe(1)

    await handle.start()
    // dsh-bridge 修复回归:验证 ctx.jobs 不为 undefined。
    // 修复前:createDshRuntime start() 内只 import('@deepseek-ai/dsh-jobs-local')
    // 没 ctx.plugin(LocalJobRegistry) → dsh-tool-bash 跑 run_in_background
    // 时 ctx.get('jobs') === undefined,抛 "background jobs unavailable"。
    expect(handle.ctx.get('jobs')).toBeDefined()
    await handle.shutdown()
    expect(handle.activeCount()).toBe(0)
  }, 60_000)

  // 清理临时目录
  it('清理临时 dataDir', () => {
    rmSync(tmpDataDir, { recursive: true, force: true })
  })
})
