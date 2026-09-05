/**
 * buildChildEnv 白名单最小化测试 —— 锁定子进程 env 不会泄漏宿主无关变量。
 *
 * 覆盖:
 * - runtime 必备字段(PATH / HOME / NODE_ENV / LANG 等)必须透传
 * - LLM provider 凭证前缀(ANTHROPIC_* / OPENAI_* / GEMINI_* / GOOGLE_* /
 *   DEEPSEEK_*)必须透传,覆盖 *_API_KEY / *_AUTH_TOKEN / *_BASE_URL /
 *   *_DEFAULT_*_MODEL 等命名形态
 * - 业务锚点 CLAUDE_CODE_SIMPLE 必须强制压平为 '0',即使宿主未注入也写
 * - 任何未列入白名单的变量(包括用户 shell 自定义变量 / HOME_USER_VAR 等
 *   测试注入的假变量)必须被丢弃
 *
 * 测试用 mock source 而非 vi.stubGlobal('process.env'),避免污染其它测试。
 */

import { describe, expect, it } from 'vitest'
import { buildChildEnv } from '../../../../src/server/services/sessionHost/cliSpawn.js'

function makeMockSource(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  // 起始 baseline:runtime 必备 + 一组 LLM provider 凭证 + 业务锚点
  // + 一个"应当被丢弃"的假变量(模拟宿主 shell 泄漏)
  const source: NodeJS.ProcessEnv = {
    // runtime
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/Users/tester',
    USER: 'tester',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'Asia/Shanghai',
    TMPDIR: '/tmp',
    NODE_ENV: 'test',
    PWD: '/Users/tester/project',
    OLDPWD: '/Users/tester',
    TERM: 'xterm-256color',
    // LLM provider 凭证(覆盖常见命名形态)
    ANTHROPIC_AUTH_TOKEN: 'sk-ant-mock-token-12345',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1',
    OPENAI_API_KEY: 'sk-openai-mock-67890',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    GEMINI_API_KEY: 'gemini-mock-aaa',
    GOOGLE_API_KEY: 'google-mock-bbb',
    DEEPSEEK_API_KEY: 'deepseek-mock-ccc',
    // 业务锚点(故意非 '0',验证强制压平)
    CLAUDE_CODE_SIMPLE: '1',
    // 应被丢弃的变量(用户 shell 泄漏 / 业务无关)
    HOME_USER_VAR: 'should-be-dropped-secret',
    DATABASE_URL: 'postgres://user:pass@host/db',
    SSH_AUTH_SOCK: '/tmp/should-not-leak.sock',
    GIT_AUTHOR_NAME: 'should-be-dropped',
    RANDOM_USER_TOKEN: 'definitely-leaked-before',
    ...overrides,
  }
  return source
}

describe('buildChildEnv', () => {
  it('透传 runtime 必备变量', () => {
    const source = makeMockSource()
    const env = buildChildEnv(source)
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(env.HOME).toBe('/Users/tester')
    expect(env.USER).toBe('tester')
    expect(env.SHELL).toBe('/bin/zsh')
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.LC_ALL).toBe('en_US.UTF-8')
    expect(env.TZ).toBe('Asia/Shanghai')
    expect(env.TMPDIR).toBe('/tmp')
    expect(env.NODE_ENV).toBe('test')
    expect(env.PWD).toBe('/Users/tester/project')
    expect(env.OLDPWD).toBe('/Users/tester')
    expect(env.TERM).toBe('xterm-256color')
  })

  it('透传 LLM provider 凭证白名单前缀(ANTHROPIC_/OPENAI_/GEMINI_/GOOGLE_/DEEPSEEK_)', () => {
    const source = makeMockSource()
    const env = buildChildEnv(source)
    // ANTHROPIC_*
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-mock-token-12345')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-1')
    // OPENAI_*
    expect(env.OPENAI_API_KEY).toBe('sk-openai-mock-67890')
    expect(env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    // GEMINI_/GOOGLE_/DEEPSEEK_*
    expect(env.GEMINI_API_KEY).toBe('gemini-mock-aaa')
    expect(env.GOOGLE_API_KEY).toBe('google-mock-bbb')
    expect(env.DEEPSEEK_API_KEY).toBe('deepseek-mock-ccc')
  })

  it('丢弃非白名单前缀的 *API_KEY 变量(防 credential 泄漏面扩大)', () => {
    // 第三方 proxy 习惯用 CUSTOM_OPENAI_API_KEY / MY_OPENAI_TOKEN 等
    // 不在白名单内的命名 —— 这些不应被透传,白名单策略是"显式枚举"
    // 而非"按 *API_KEY 后缀放行"。这是任务的关键不变量。
    const source = makeMockSource({
      CUSTOM_OPENAI_API_KEY: 'should-not-leak',
      MY_OPENAI_TOKEN: 'should-not-leak',
      RANDOM_PROVIDER_KEY: 'should-not-leak',
    })
    const env = buildChildEnv(source)
    expect(env.CUSTOM_OPENAI_API_KEY).toBeUndefined()
    expect(env.MY_OPENAI_TOKEN).toBeUndefined()
    expect(env.RANDOM_PROVIDER_KEY).toBeUndefined()
  })

  it('业务锚点 CLAUDE_CODE_SIMPLE 强制压平为 "0"(即使宿主注入 "1" 也覆盖)', () => {
    const source = makeMockSource({ CLAUDE_CODE_SIMPLE: '1' })
    const env = buildChildEnv(source)
    expect(env.CLAUDE_CODE_SIMPLE).toBe('0')
  })

  it('业务锚点 CLAUDE_CODE_SIMPLE 强制压平:宿主未注入也写死 "0"', () => {
    const source = makeMockSource()
    delete source.CLAUDE_CODE_SIMPLE
    const env = buildChildEnv(source)
    expect(env.CLAUDE_CODE_SIMPLE).toBe('0')
  })

  it('丢弃未列入白名单的变量(含 HOME_USER_VAR / DATABASE_URL / SSH_AUTH_SOCK / GIT_*)', () => {
    const source = makeMockSource()
    const env = buildChildEnv(source)
    expect(env.HOME_USER_VAR).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(env.GIT_AUTHOR_NAME).toBeUndefined()
    expect(env.RANDOM_USER_TOKEN).toBeUndefined()
  })

  it('返回值不包含任何白名单外的 key(全集断言)', () => {
    const source = makeMockSource()
    const env = buildChildEnv(source)
    const allowedKeys = new Set([
      'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR',
      'NODE_ENV', 'PWD', 'OLDPWD', 'TERM', 'CLAUDE_CODE_SIMPLE',
      'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'OPENAI_API_KEY', 'OPENAI_BASE_URL',
      'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY',
    ])
    for (const key of Object.keys(env)) {
      expect(allowedKeys.has(key), `unexpected env key leaked: ${key}`).toBe(true)
    }
    // 必须丢弃的 key 不在返回值里
    expect(Object.keys(env)).not.toContain('HOME_USER_VAR')
    expect(Object.keys(env)).not.toContain('DATABASE_URL')
    expect(Object.keys(env)).not.toContain('SSH_AUTH_SOCK')
  })

  it('纯函数:不修改入参 source 对象', () => {
    const source = makeMockSource()
    const snapshot = JSON.stringify(source)
    buildChildEnv(source)
    expect(JSON.stringify(source)).toBe(snapshot)
  })

  it('空 source 只返回业务锚点 CLAUDE_CODE_SIMPLE="0"', () => {
    const env = buildChildEnv({})
    expect(env).toEqual({ CLAUDE_CODE_SIMPLE: '0' })
  })
})
