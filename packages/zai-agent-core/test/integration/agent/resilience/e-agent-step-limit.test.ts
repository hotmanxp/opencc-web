/**
 * Integration tests — E.1 agent step limit (getAgentStepLimit).
 *
 * Covers spec §3 behaviors 1-4 (step-counter 行为) and §4 the 6 cases listed
 * for e-agent-step-limit. TDD: tests first, then implementation in
 * stepCounter.ts makes them green.
 *
 * Spec references:
 *   - §2.1 函数签名 + 优先级: userOptIn > config > env
 *   - §2.4 错误契约: getAgentStepLimit 永不抛,无 config → null
 *   - §3 行为 1-4 (前 4 个): config / env / userOptIn / disable env
 *   - §4 测试点 6 个
 */
import { describe, test, expect } from 'vitest'
import { getAgentStepLimit } from '../../../../src/runtime/summary/stepCounter.js'

// ---- tests -----------------------------------------------------------------

describe('integration: getAgentStepLimit (agent step limit)', () => {
  // §4 case 1 + §3 行为 1: 无 config / env / userOptIn → null
  test('returns null when no config / env / userOptIn provided', () => {
    expect(getAgentStepLimit({})).toBeNull()
    expect(getAgentStepLimit({ env: {} })).toBeNull()
    expect(getAgentStepLimit({ config: {} })).toBeNull()
  })

  // §4 case 2 + §3 行为 1: config.runtime.agentStepLimit set → 透传
  test('returns config.runtime.agentStepLimit when set', () => {
    const limit = getAgentStepLimit({
      config: { runtime: { agentStepLimit: 25 } },
    })
    expect(limit).toBe(25)
  })

  // §4 case 3 + §3 行为 2: env.ZAI_AGENT_STEP_LIMIT 解析成整数
  test('returns parsed env.ZAI_AGENT_STEP_LIMIT when config absent', () => {
    const limit = getAgentStepLimit({
      env: { ZAI_AGENT_STEP_LIMIT: '42' },
    })
    expect(limit).toBe(42)
  })

  // §3 行为 3 (part of priority order): userOptIn 优先于 config
  test('userOptIn overrides config when both provided', () => {
    const limit = getAgentStepLimit({
      config: { runtime: { agentStepLimit: 25 } },
      userOptIn: 7,
    })
    expect(limit).toBe(7)
  })

  // §3 行为 3: userOptIn 优先于 env
  test('userOptIn overrides env when both provided', () => {
    const limit = getAgentStepLimit({
      env: { ZAI_AGENT_STEP_LIMIT: '42' },
      userOptIn: 7,
    })
    expect(limit).toBe(7)
  })

  // §3 行为 3: 三者同时存在时 userOptIn 最优先
  test('userOptIn has highest priority over both config and env', () => {
    const limit = getAgentStepLimit({
      config: { runtime: { agentStepLimit: 25 } },
      env: { ZAI_AGENT_STEP_LIMIT: '42' },
      userOptIn: 7,
    })
    expect(limit).toBe(7)
  })

  // §4 case 4 + §3 行为 4: ZAI_DISABLE_AGENT_STEP_LIMIT='1' → null(无论其它)
  test('returns null when env.ZAI_DISABLE_AGENT_STEP_LIMIT=1, ignoring config and userOptIn', () => {
    expect(
      getAgentStepLimit({
        config: { runtime: { agentStepLimit: 25 } },
        env: { ZAI_DISABLE_AGENT_STEP_LIMIT: '1' },
      }),
    ).toBeNull()
    expect(
      getAgentStepLimit({
        config: { runtime: { agentStepLimit: 25 } },
        env: { ZAI_DISABLE_AGENT_STEP_LIMIT: '1' },
        userOptIn: 7,
      }),
    ).toBeNull()
  })

  // §3 行为 2 (extra): config 比 env 优先(优先级: userOptIn > config > env)
  test('config takes priority over env when no userOptIn', () => {
    const limit = getAgentStepLimit({
      config: { runtime: { agentStepLimit: 25 } },
      env: { ZAI_AGENT_STEP_LIMIT: '42' },
    })
    expect(limit).toBe(25)
  })

  // §3 行为 2 (extra): env 解析非法整数 → null(不抛)
  test('env.ZAI_AGENT_STEP_LIMIT with non-integer value falls back to null', () => {
    expect(getAgentStepLimit({ env: { ZAI_AGENT_STEP_LIMIT: 'abc' } })).toBeNull()
    expect(getAgentStepLimit({ env: { ZAI_AGENT_STEP_LIMIT: '1.5' } })).toBeNull()
    expect(getAgentStepLimit({ env: { ZAI_AGENT_STEP_LIMIT: '' } })).toBeNull()
  })

  // §2.4 错误契约: never throws on malformed inputs
  test('never throws on malformed config (null / non-object / weird runtime)', () => {
    expect(() =>
      getAgentStepLimit({ config: null as unknown as undefined }),
    ).not.toThrow()
    expect(() =>
      getAgentStepLimit({ config: { runtime: null } as unknown as { runtime: { agentStepLimit: number } } }),
    ).not.toThrow()
    expect(
      getAgentStepLimit({
        config: { runtime: { agentStepLimit: 0 } },
      }),
    ).toBe(0) // 0 is a valid value (means immediate break)
  })

  // §4 case 6 (extra): userOptIn=0 means unlimited-disabled at runtime (still null per spec since userOptIn 0 not provided via spec)
  // userOptIn=0 explicitly provided → 0 (no need to be defensive here)
  test('userOptIn=0 is honored as an explicit value', () => {
    expect(getAgentStepLimit({ userOptIn: 0 })).toBe(0)
  })

  // bonus: undefined config.runtime.agentStepLimit still falls through to env
  test('config.runtime.agentStepLimit=undefined falls through to env', () => {
    const limit = getAgentStepLimit({
      config: { runtime: { agentStepLimit: undefined } },
      env: { ZAI_AGENT_STEP_LIMIT: '99' },
    })
    expect(limit).toBe(99)
  })

  // bonus: ZAI_DISABLE_AGENT_STEP_LIMIT other values (e.g. '0', 'true') do NOT disable
  test('ZAI_DISABLE_AGENT_STEP_LIMIT only disables when value is 1', () => {
    expect(
      getAgentStepLimit({
        env: { ZAI_DISABLE_AGENT_STEP_LIMIT: '0' },
        config: { runtime: { agentStepLimit: 25 } },
      }),
    ).toBe(25)
    expect(
      getAgentStepLimit({
        env: { ZAI_DISABLE_AGENT_STEP_LIMIT: '' },
        config: { runtime: { agentStepLimit: 25 } },
      }),
    ).toBe(25)
  })
})
