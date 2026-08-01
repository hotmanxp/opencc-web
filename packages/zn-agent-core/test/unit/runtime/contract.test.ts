import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DefaultAgentRuntime } from '../../../src/compat/runtime/contract.js'

// Bridge is the default backend. We mock it so we can assert that
// DefaultAgentRuntime.run() delegates to it without hitting the real
// opencc vendor.
const openccBridgeMock = vi.hoisted(() => ({
  runViaOpenccQuery: vi.fn(),
}))

vi.mock('../../../src/compat/runtime/openccQueryBridge.js', () => openccBridgeMock)

async function* emptyStream(): AsyncGenerator<never> {
  // never yields — iterator ends immediately.
}

function configureMocks() {
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
    // transcriptStore is always injected (built from dataDir) so the
    // resume path can preload prior turns; assert on the opts arg, not
    // the openccConfig shape (see next test).
    expect(openccBridgeMock.runViaOpenccQuery).toHaveBeenCalledWith(
      opts,
      expect.objectContaining({ transcriptStore: expect.anything() }),
    )
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

    // openccConfig from caller is preserved AND transcriptStore is auto-
    // appended; assert both keys make it through.
    expect(openccBridgeMock.runViaOpenccQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mcpPool: { tag: 'pool' },
        hookRunner: { tag: 'hooks' },
        skillsDirs: ['/agents'],
        transcriptStore: expect.anything(),
      }),
    )
  })

  it('falls back to {} openccConfig when none supplied', async () => {
    const rt = makeRuntime()
    await drain(rt.run({
      prompt: { role: 'user', content: 'hi' },
      cwd: '/tmp',
      sessionId: 's',
    } as any))
    // Even with no caller openccConfig, transcriptStore is always injected.
    expect(openccBridgeMock.runViaOpenccQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transcriptStore: expect.anything() }),
    )
  })
})
