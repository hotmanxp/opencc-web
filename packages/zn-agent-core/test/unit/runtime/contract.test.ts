import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DefaultAgentRuntime } from '../../../src/compat/runtime/contract.js'

// Mock both backends so we can assert which one contract.run() delegates to.
// The mocks return an empty AsyncIterable so the iterator chain terminates
// without actual model I/O — we only care which export was called.
const openccAdapterMock = vi.hoisted(() => ({
  runOpenccQuery: vi.fn(),
}))
const openccBridgeMock = vi.hoisted(() => ({
  runViaOpenccQuery: vi.fn(),
}))

vi.mock('../../../src/compat/runtime/openccAdapter.js', () => openccAdapterMock)
vi.mock('../../../src/compat/runtime/openccQueryBridge.js', () => openccBridgeMock)

async function* emptyStream(): AsyncGenerator<never> {
  // never yields — iterator ends immediately.
}
// Suppress Bun-style TS check on no-yield async generator (TS 5.x).
void (async function* () {})()

function configureMocks() {
  openccAdapterMock.runOpenccQuery.mockImplementation(() => emptyStream())
  openccBridgeMock.runViaOpenccQuery.mockImplementation(() => emptyStream())
}

async function drain(run: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const ev of run) out.push(ev)
  return out
}

function makeRuntime(): DefaultAgentRuntime {
  // Minimum viable RuntimeConfig — contract.run() only forwards opts
  // and an openccConfig-shaped block; TranscriptStore needs dataDir.
  return new DefaultAgentRuntime({
    dataDir: '/tmp',
  } as any)
}

describe('DefaultAgentRuntime.run — env-gated backend switch (Phase 5 close-out)', () => {
  let savedBridge: string | undefined

  beforeEach(() => {
    configureMocks()
    savedBridge = process.env.ZAI_OPENCC_BRIDGE
    delete process.env.ZAI_OPENCC_BRIDGE
  })

  afterEach(() => {
    if (savedBridge === undefined) delete process.env.ZAI_OPENCC_BRIDGE
    else process.env.ZAI_OPENCC_BRIDGE = savedBridge
    openccAdapterMock.runOpenccQuery.mockReset()
    openccBridgeMock.runViaOpenccQuery.mockReset()
  })

  it('default: routes through runOpenccQuery (Phase 1.b bypass)', async () => {
    const rt = makeRuntime()
    await drain(rt.run({
      prompt: { role: 'user', content: 'hi' },
      cwd: '/tmp',
      sessionId: 's',
    } as any))

    expect(openccAdapterMock.runOpenccQuery).toHaveBeenCalledTimes(1)
    expect(openccBridgeMock.runViaOpenccQuery).not.toHaveBeenCalled()
  })

  it('ZAI_OPENCC_BRIDGE=1: routes through runViaOpenccQuery', async () => {
    process.env.ZAI_OPENCC_BRIDGE = '1'
    const rt = makeRuntime()
    await drain(rt.run({
      prompt: { role: 'user', content: 'hi' },
      cwd: '/tmp',
      sessionId: 's',
    } as any))

    expect(openccBridgeMock.runViaOpenccQuery).toHaveBeenCalledTimes(1)
    expect(openccAdapterMock.runOpenccQuery).not.toHaveBeenCalled()
  })

  it('ZAI_OPENCC_BRIDGE=true (alias): routes through runViaOpenccQuery', async () => {
    process.env.ZAI_OPENCC_BRIDGE = 'true'
    const rt = makeRuntime()
    await drain(rt.run({
      prompt: { role: 'user', content: 'hi' },
      cwd: '/tmp',
      sessionId: 's',
    } as any))

    expect(openccBridgeMock.runViaOpenccQuery).toHaveBeenCalledTimes(1)
  })

  it('ZAI_OPENCC_BRIDGE=0: still uses bypass (env:1 only)', async () => {
    process.env.ZAI_OPENCC_BRIDGE = '0'
    const rt = makeRuntime()
    await drain(rt.run({
      prompt: { role: 'user', content: 'hi' },
      cwd: '/tmp',
      sessionId: 's',
    } as any))

    expect(openccAdapterMock.runOpenccQuery).toHaveBeenCalledTimes(1)
    expect(openccBridgeMock.runViaOpenccQuery).not.toHaveBeenCalled()
  })

  it('ZAI_OPENCC_BRIDGE=1 passes openccConfig through to the bridge', async () => {
    process.env.ZAI_OPENCC_BRIDGE = '1'
    const openccConfig = {
      mcpPool: { tag: 'pool' },
      hookRunner: { tag: 'hooks' },
    }
    const rt = new DefaultAgentRuntime({ dataDir: '/tmp' } as any)
    // Inject openccConfig via a manual override — RuntimeConfig doesn't
    // expose it in the public type, contract.run() reads `this.config.openccConfig`.
    ;(rt as any).config = { ...(rt as any).config, openccConfig }

    await drain(rt.run({
      prompt: { role: 'user', content: 'hi' },
      cwd: '/tmp',
      sessionId: 's',
    } as any))

    expect(openccBridgeMock.runViaOpenccQuery).toHaveBeenCalledWith(
      expect.anything(),
      openccConfig,
    )
  })
})
