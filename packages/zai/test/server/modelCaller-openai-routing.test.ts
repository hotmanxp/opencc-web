import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// We need to control homedir() BEFORE modelCaller.ts loads, so use vi.mock
// at module top with a mutable path. The mock reads a `currentHome` variable
// that we set in beforeEach.
let currentHome = ''
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => currentHome,
  }
})

// Mock openaiClient so we can detect when an OpenAI-profile session routes
// through it (vs the Anthropic SDK). Capture all constructions.
const openaiClientCalls: Array<{ baseURL: string; apiKey: string; model: string }> = []
vi.mock('../../src/server/services/openaiClient.js', () => ({
  OpenAIClient: class FakeOpenAIClient {
    constructor(opts: { baseURL: string; apiKey: string; model: string }) {
      openaiClientCalls.push(opts)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages = { create: (..._args: any[]) => (async function* () { /* empty stream */ })() }
  },
}))

// Mock Anthropic SDK so we can detect when Anthropic-profile (or MISS) routes
// through it.
const anthropicCalls: Array<{ authToken?: string; baseURL: string }> = []
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    constructor(opts: { authToken?: string; baseURL: string }) {
      anthropicCalls.push(opts)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages = { create: (..._args: any[]) => (async function* () { /* empty stream */ })() }
  }
  return { default: FakeAnthropic }
})

// Import after mocks so module resolution picks up the fakes.
const modelCallerModule = await import('../../src/server/services/modelCaller.js')

beforeEach(() => {
  openaiClientCalls.length = 0
  anthropicCalls.length = 0
  currentHome = mkdtempSync(join(tmpdir(), 'zai-routing-'))
})

afterEach(() => {
  rmSync(currentHome, { recursive: true, force: true })
})

function writeSettings(env: Record<string, string>) {
  const dir = join(currentHome, '.zai')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('node:fs').mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'),
    JSON.stringify({ env }), 'utf-8')
}
function writeClaude(profiles: unknown[]) {
  writeFileSync(join(currentHome, '.claude.json'),
    JSON.stringify({ providerProfiles: profiles }), 'utf-8')
}

describe('modelCaller → client routing', () => {
  it('OpenAI profile (chat_completions) → OpenAIClient, not Anthropic SDK', async () => {
    writeSettings({
      ANTHROPIC_AUTH_TOKEN: 'anthropic-tok',
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
      OPENAI_API_KEY: 'openai-tok',
    })
    writeClaude([
      {
        id: 'p_openai',
        name: 'MiniMax-Test',
        provider: 'openai',
        baseUrl: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M2.1',
        apiFormat: 'chat_completions',
      },
    ])

    // The createAnthropicModelCaller is the public surface. Internally it
    // calls getAnthropicClientForModel(model). Invoke it through a modelCaller
    // run so the client cache is exercised end-to-end. We just need ONE
    // stream-event to fire so the Anthropic SDK would also be hit if the
    // routing were wrong.
    const mc = modelCallerModule.createAnthropicModelCaller()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = mc({
      model: 'MiniMax-M2.1',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    } as any)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of gen) { /* drain */ }

    expect(openaiClientCalls.length).toBe(1)
    expect(openaiClientCalls[0]).toEqual({
      baseURL: 'https://api.minimaxi.com/v1',
      apiKey: 'openai-tok',
      model: 'MiniMax-M2.1',
    })
    expect(anthropicCalls.length).toBe(0)
  })

  it('Anthropic profile → Anthropic SDK only (no OpenAIClient construction)', async () => {
    writeSettings({
      ANTHROPIC_AUTH_TOKEN: 'anthropic-tok',
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
      OPENAI_API_KEY: 'openai-tok',
    })
    writeClaude([
      {
        id: 'p_anth',
        name: 'Anthropic-Mix',
        provider: 'anthropic',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        model: 'MiniMax-M3',
      },
    ])

    const mc = modelCallerModule.createAnthropicModelCaller()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = mc({
      model: 'MiniMax-M3',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    } as any)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of gen) { /* drain */ }

    expect(anthropicCalls.length).toBe(1)
    expect(anthropicCalls[0].authToken).toBe('anthropic-tok')
    expect(openaiClientCalls.length).toBe(0)
  })

  it('MISS (no profile) → Anthropic SDK with env fallback', async () => {
    writeSettings({
      ANTHROPIC_AUTH_TOKEN: 'env-fallback-tok',
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
    })
    writeClaude([])

    const mc = modelCallerModule.createAnthropicModelCaller()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = mc({
      model: 'MiniMax-M2.1',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    } as any)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of gen) { /* drain */ }

    expect(anthropicCalls.length).toBe(1)
    expect(anthropicCalls[0].authToken).toBe('env-fallback-tok')
    expect(openaiClientCalls.length).toBe(0)
  })
})