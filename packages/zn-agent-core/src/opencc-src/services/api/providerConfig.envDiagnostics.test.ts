// @ts-nocheck
import { afterEach, expect, mock, test } from 'bun:test'

const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

afterEach(() => {
  restoreEnv('CLAUDE_CODE_USE_OPENAI', originalEnv.CLAUDE_CODE_USE_OPENAI)
  restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
  restoreEnv('OPENAI_MODEL', originalEnv.OPENAI_MODEL)
  restoreEnv('OPENAI_API_BASE', originalEnv.OPENAI_API_BASE)
  mock.restore()
})

test('logs a warning when OPENAI_BASE_URL is literal undefined', async () => {
  const debugSpy = mock(() => {})
  mock.module('../../utils/debug.js', () => ({
    logForDebugging: debugSpy,
  }))

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'undefined'
  process.env.OPENAI_MODEL = 'gpt-4o'
  delete process.env.OPENAI_API_BASE

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`./providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest()

  expect(resolved.baseUrl).toBe('https://api.openai.com/v1')

  const warningCall = debugSpy.mock.calls.find(call =>
    typeof call?.[0] === 'string' &&
    call[0].includes('OPENAI_BASE_URL') &&
    call[0].includes('"undefined"'),
  )

  expect(warningCall).toBeDefined()
  expect(warningCall?.[1]).toEqual({ level: 'warn' })
})

test('does not warn for OPENAI_API_BASE when OPENAI_BASE_URL is active', async () => {
  const debugSpy = mock(() => {})
  mock.module('../../utils/debug.js', () => ({
    logForDebugging: debugSpy,
  }))

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1'
  process.env.OPENAI_MODEL = 'qwen2.5-coder:7b'
  process.env.OPENAI_API_BASE = 'undefined'

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`./providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest()

  expect(resolved.baseUrl).toBe('http://127.0.0.1:11434/v1')

  const aliasWarning = debugSpy.mock.calls.find(call =>
    typeof call?.[0] === 'string' &&
    call[0].includes('OPENAI_API_BASE') &&
    call[0].includes('"undefined"'),
  )

  expect(aliasWarning).toBeUndefined()
})
