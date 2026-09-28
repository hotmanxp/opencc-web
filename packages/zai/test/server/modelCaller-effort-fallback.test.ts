import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// homedir() must be controlled before modelCaller.ts loads.
let currentHome = ''
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => currentHome }
})

// Capture the request body actually handed to the Anthropic SDK, which is
// where `reasoning.effort` lands (services/modelCaller.ts create() call).
const createBodies: Array<Record<string, unknown>> = []
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
    messages = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: (body: any) => {
        createBodies.push(body)
        return (async function* () { /* empty stream */ })()
      },
    }
  }
  return { default: FakeAnthropic }
})

const modelCallerModule = await import('../../src/server/services/modelCaller.js')

beforeEach(() => {
  createBodies.length = 0
  currentHome = mkdtempSync(join(tmpdir(), 'zai-effort-'))
})

afterEach(() => {
  rmSync(currentHome, { recursive: true, force: true })
})

function writeSettings(env: Record<string, string>) {
  const dir = join(currentHome, '.zai')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env }), 'utf-8')
}

function writeClaude(profiles: unknown[]) {
  writeFileSync(join(currentHome, '.zai.json'), JSON.stringify({ providerProfiles: profiles }), 'utf-8')
}

function anthropicProfile(model: string, capabilities?: Record<string, unknown>) {
  return {
    id: `p_${model}`,
    name: 'Test-Anthropic',
    provider: 'anthropic',
    baseUrl: 'https://api.example.test/anthropic',
    model,
    ...(capabilities ? { capabilities } : {}),
  }
}

async function callOnce(model: string, effort?: string) {
  const mc = modelCallerModule.createAnthropicModelCaller()
  const gen = mc({
    model,
    systemPrompt: '',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
    ...(effort !== undefined ? { options: { effort } } : {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  for await (const _ev of gen) { /* drain */ }
  return createBodies[createBodies.length - 1]
}

function reasoningOf(body: Record<string, unknown> | undefined) {
  return body?.reasoning
}

describe('modelCaller — reasoning effort fallback', () => {
  // Each case uses a distinct model name: modelCaller keeps a module-level
  // client cache keyed by model, so a reused name would serve a stale client
  // and the capabilities of the previous profile.
  it('never-picked effort on a reasoning model → sends the default level', async () => {
    const model = 'Effort-Default-On'
    writeSettings({ ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://api.example.test' })
    writeClaude([anthropicProfile(model, { [model]: { supportsReasoning: true } })])

    const body = await callOnce(model)
    expect(reasoningOf(body)).toEqual({ effort: 'high' })
  })

  it('never-picked effort on a non-reasoning model → sends no reasoning field', async () => {
    // Sending reasoning.effort to a model that rejects it is a guaranteed 400
    // (MiniMax answers 2013), so an undeclared capability must stay silent.
    const model = 'Effort-Default-Off'
    writeSettings({ ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://api.example.test' })
    writeClaude([anthropicProfile(model, { [model]: { supportsReasoning: false } })])

    const body = await callOnce(model)
    expect(reasoningOf(body)).toBeUndefined()
  })

  it('profile declares no capabilities at all → sends no reasoning field', async () => {
    const model = 'Effort-NoCaps'
    writeSettings({ ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://api.example.test' })
    writeClaude([anthropicProfile(model)])

    const body = await callOnce(model)
    expect(reasoningOf(body)).toBeUndefined()
  })

  it("explicit 'off' → stays silent even on a reasoning model", async () => {
    // 'off' is a real user choice, not an absence — the fallback must not
    // override it back to the default level.
    const model = 'Effort-ExplicitOff'
    writeSettings({ ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://api.example.test' })
    writeClaude([anthropicProfile(model, { [model]: { supportsReasoning: true } })])

    const body = await callOnce(model, 'off')
    expect(reasoningOf(body)).toBeUndefined()
  })

  it('an explicitly picked level wins over the default', async () => {
    const model = 'Effort-ExplicitLow'
    writeSettings({ ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://api.example.test' })
    writeClaude([anthropicProfile(model, { [model]: { supportsReasoning: true } })])

    const body = await callOnce(model, 'low')
    expect(reasoningOf(body)).toEqual({ effort: 'low' })
  })

  it('a value outside the wire whitelist is dropped, not forwarded', async () => {
    const model = 'Effort-Bogus'
    writeSettings({ ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://api.example.test' })
    writeClaude([anthropicProfile(model, { [model]: { supportsReasoning: true } })])

    const body = await callOnce(model, 'ultracode')
    expect(reasoningOf(body)).toBeUndefined()
  })
})
