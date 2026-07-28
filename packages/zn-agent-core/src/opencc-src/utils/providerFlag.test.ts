// @ts-nocheck
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  parseProviderFlag,
  applyProviderFlag,
  applyProviderFlagFromArgs,
  VALID_PROVIDERS,
} from './providerFlag.js'

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
]

const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }
})

const RESET_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
] as const

beforeEach(() => {
  for (const key of RESET_KEYS) {
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }
})

// --- parseProviderFlag ---

describe('parseProviderFlag', () => {
  test('returns provider name when --provider flag present', () => {
    expect(parseProviderFlag(['--provider', 'openai'])).toBe('openai')
  })

  test('returns provider name with --model alongside', () => {
    expect(parseProviderFlag(['--provider', 'ollama', '--model', 'llama3.2'])).toBe('ollama')
  })

  test('returns null when --provider flag absent', () => {
    expect(parseProviderFlag(['--model', 'gpt-4o'])).toBeNull()
  })

  test('returns null for empty args', () => {
    expect(parseProviderFlag([])).toBeNull()
  })

  test('returns null when --provider has no value', () => {
    expect(parseProviderFlag(['--provider'])).toBeNull()
  })

  test('returns null when --provider value starts with --', () => {
    expect(parseProviderFlag(['--provider', '--model'])).toBeNull()
  })
})

// --- applyProviderFlag ---

describe('applyProviderFlag - anthropic', () => {
  test('sets no env vars for anthropic (default)', () => {
    const result = applyProviderFlag('anthropic', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  })
})

describe('applyProviderFlag - openai', () => {
  test('sets CLAUDE_CODE_USE_OPENAI=1', () => {
    const result = applyProviderFlag('openai', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
  })

  test('sets OPENAI_MODEL when --model is provided', () => {
    applyProviderFlag('openai', ['--model', 'gpt-4o'])
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
  })
})

describe('applyProviderFlag - ollama', () => {
  test('sets CLAUDE_CODE_USE_OPENAI=1 with Ollama defaults when unset', () => {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY

    const result = applyProviderFlag('ollama', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_API_KEY).toBe('ollama')
  })

  test('sets OPENAI_MODEL when --model is provided', () => {
    applyProviderFlag('ollama', ['--model', 'llama3.2'])
    expect(process.env.OPENAI_MODEL).toBe('llama3.2')
  })

  test('does not override existing OPENAI_BASE_URL when user set a custom one', () => {
    process.env.OPENAI_BASE_URL = 'http://my-ollama:11434/v1'
    applyProviderFlag('ollama', [])
    expect(process.env.OPENAI_BASE_URL).toBe('http://my-ollama:11434/v1')
  })

  test('preserves explicit OPENAI_BASE_URL and OPENAI_API_KEY overrides', () => {
    process.env.OPENAI_BASE_URL = 'http://remote-ollama.internal:11434/v1'
    process.env.OPENAI_API_KEY = 'secret-token'

    applyProviderFlag('ollama', [])

    expect(process.env.OPENAI_BASE_URL).toBe('http://remote-ollama.internal:11434/v1')
    expect(process.env.OPENAI_API_KEY).toBe('secret-token')
  })
})

describe('applyProviderFlag - xai', () => {
  test('sets CLAUDE_CODE_USE_OPENAI=1 with xAI defaults when unset', () => {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY

    const result = applyProviderFlag('xai', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.x.ai/v1')
    expect(process.env.OPENAI_MODEL).toBe('grok-4')
  })

  test('sets OPENAI_MODEL when --model is provided', () => {
    applyProviderFlag('xai', ['--model', 'grok-3'])
    expect(process.env.OPENAI_MODEL).toBe('grok-3')
  })

  test('propagates XAI_API_KEY to OPENAI_API_KEY when only XAI_API_KEY is set', () => {
    delete process.env.OPENAI_API_KEY
    process.env.XAI_API_KEY = 'xai-secret-key'

    applyProviderFlag('xai', [])

    expect(process.env.OPENAI_API_KEY).toBe('xai-secret-key')
  })

  test('does not override existing OPENAI_API_KEY when both keys are set', () => {
    process.env.OPENAI_API_KEY = 'existing-openai-key'
    process.env.XAI_API_KEY = 'xai-secret-key'

    applyProviderFlag('xai', [])

    expect(process.env.OPENAI_API_KEY).toBe('existing-openai-key')
  })
})

describe('applyProviderFlag - invalid provider', () => {
  test('returns error for unknown provider', () => {
    const result = applyProviderFlag('unknown-provider', [])
    expect(result.error).toContain('unknown-provider')
    expect(result.error).toContain(VALID_PROVIDERS.join(', '))
  })
})

describe('applyProviderFlagFromArgs', () => {
  test('applies ollama provider and model from argv in one step', () => {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY

    const result = applyProviderFlagFromArgs([
      '--provider',
      'ollama',
      '--model',
      'llama3.2',
    ])

    expect(result?.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_API_KEY).toBe('ollama')
    expect(process.env.OPENAI_MODEL).toBe('llama3.2')
  })

  test('returns undefined when --provider is absent', () => {
    expect(applyProviderFlagFromArgs(['--model', 'gpt-4o'])).toBeUndefined()
  })
})
