import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DefaultAgentRuntime } from '../../../src/compat/runtime/contract.js'

// Bridge is now the default backend. We mock the two backends so we can
// assert which one DefaultAgentRuntime.run() delegates to without hitting
// the real opencc vendor.
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
  // Minimum viable RuntimeConfig — contract.run() only forwards opts and
  // an openccConfig-shaped block; TranscriptStore needs dataDir.
  return new DefaultAgentRuntime({ dataDir: '/tmp' } as any)
}

describe('DefaultAgentRuntime.run — bridge is now the default backend (Phase 5)', () => {
  beforeEach(() => {
    configureMocks()
  })

  afterEach(() => {
    openccAdapterMock.runOpenccQuery.mockReset()
    openccBridgeMock.runViaOpenccQuery.mockReset()
  })

  it('routes through runViaOpenccQuery (bridge) by default', async () => {
    const rt = makeRuntime()
    await drain(rt.run({
      prompt: { role: 'user', content: 'hi' },
      cwd: '/tmp',
      sessionId: 's',
    } as any))

    expect(openccBridgeMock.runViaOpenccQuery).toHaveBeenCalledTimes(1)
    expect(openccAdapterMock.runOpenccQuery).not.toHaveBeenCalled()
  })

  it('passes opts through to the bridge unchanged', async () => {
    const rt = makeRuntime()
    const opts = {
      prompt: { role: 'user', content: 'hi' },
      cwd: '/tmp',
      sessionId: 's',
      model: 'm',
      tools: [{ name: 'X' }],
    } as any
    await drain(rt.run(opts))
    expect(openccBridgeMock.runViaOpenccQuery).toHaveBeenCalledWith(opts, {})
  })

  it('passes openccConfig through to the bridge', async () => {
    const openccConfig = {
      mcpPool: { tag: 'pool' },
      hookRunner: { tag: 'hooks' },
      skillsDirs: ['/agents'],
    }
    const rt = new DefaultAgentRuntime({ dataDir: '/tmp' } as any)
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

  it('falls back to {} openccConfig when none supplied', async () => {
    const rt = makeRuntime()
    await drain(rt.run({
      prompt: { role: 'user', content: 'hi' },
      cwd: '/tmp',
      sessionId: 's',
    } as any))
    expect(openccBridgeMock.runViaOpenccQuery).toHaveBeenCalledWith(
      expect.anything(),
      {},
    )
  })
})
