import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { wrapHeadlessPermissionFn } from '../../../src/opencc-src/server/headlessPermissionBridge.js'

const BRIDGE_KEY = '__zaiBridgeCtx'

function makeTool(name: string) {
  return {
    name,
    description: async () => `${name} description`,
    inputSchema: { parse: (v: unknown) => v },
  }
}

function makeToolUseContext(abortSignal: AbortSignal) {
  return {
    getAppState: () => ({ toolPermissionContext: { mode: 'plan' } }),
    options: { tools: [] },
    abortController: { signal: abortSignal },
  }
}

describe('wrapHeadlessPermissionFn — behavior:ask → bridge confirm', () => {
  let savedBridge: unknown

  beforeEach(() => {
    savedBridge = (globalThis as any)[BRIDGE_KEY]
  })

  afterEach(() => {
    if (savedBridge === undefined) delete (globalThis as any)[BRIDGE_KEY]
    else (globalThis as any)[BRIDGE_KEY] = savedBridge
  })

  it('passes through non-ask decisions untouched', async () => {
    const fn = wrapHeadlessPermissionFn(async () => ({ behavior: 'allow' }))
    const decision = await fn(
      makeTool('Bash') as any,
      { command: 'ls' },
      makeToolUseContext(new AbortController().signal) as any,
      {} as any,
      'tu-1',
      undefined,
    )
    expect(decision).toEqual({ behavior: 'allow' })
  })

  it('resolves allow through the permissionRegistry', async () => {
    let registered: { toolUseId: string; sessionId: string } | null = null
    ;(globalThis as any)[BRIDGE_KEY] = {
      sessionId: 'sess-p',
      onYield: (e: any) => { yielded.push(e) },
      permissionRegistry: {
        register: async (toolUseId: string, sessionId: string) => {
          registered = { toolUseId, sessionId }
          return { decision: 'allow' }
        },
      },
    }
    const yielded: unknown[] = []
    ;(globalThis as any)[BRIDGE_KEY].onYield = (e: any) => { yielded.push(e) }

    const fn = wrapHeadlessPermissionFn(async () => ({
      behavior: 'ask',
      message: 'Exit plan mode?',
      decisionReason: { type: 'mode', mode: 'plan' },
    }))
    const decision = await fn(
      makeTool('ExitPlanMode') as any,
      { allowedPrompts: [] },
      makeToolUseContext(new AbortController().signal) as any,
      {} as any,
      'tu-exit',
      undefined,
    )

    expect(registered).toEqual({ toolUseId: 'tu-exit', sessionId: 'sess-p' })
    expect(yielded).toHaveLength(1)
    expect(yielded[0]).toMatchObject({
      type: 'tool_use:permission_pending',
      toolUseId: 'tu-exit',
      toolName: 'ExitPlanMode',
    })
    expect(decision).toMatchObject({
      behavior: 'allow',
      updatedInput: { allowedPrompts: [] },
    })
  })

  it('resolves deny with a message', async () => {
    ;(globalThis as any)[BRIDGE_KEY] = {
      sessionId: 'sess-p',
      onYield: () => {},
      permissionRegistry: {
        register: async () => ({ decision: 'deny', message: 'user said no' }),
      },
    }
    const fn = wrapHeadlessPermissionFn(async () => ({
      behavior: 'ask',
      message: 'Run bash?',
      decisionReason: { type: 'other', reason: 'x' },
    }))
    const decision = await fn(
      makeTool('Bash') as any,
      { command: 'rm -rf /' },
      makeToolUseContext(new AbortController().signal) as any,
      {} as any,
      'tu-bash',
      undefined,
    )
    expect(decision).toMatchObject({ behavior: 'deny', message: 'user said no' })
  })

  it('returns the ask decision unchanged when no bridge is configured', async () => {
    const fn = wrapHeadlessPermissionFn(async () => ({
      behavior: 'ask',
      message: 'no bridge',
    }))
    const decision = await fn(
      makeTool('Bash') as any,
      { command: 'ls' },
      makeToolUseContext(new AbortController().signal) as any,
      {} as any,
      'tu-nobridge',
      undefined,
    )
    expect(decision).toEqual({ behavior: 'ask', message: 'no bridge' })
  })

  it('propagates abort rejection from the registry', async () => {
    ;(globalThis as any)[BRIDGE_KEY] = {
      sessionId: 'sess-p',
      onYield: () => {},
      permissionRegistry: {
        register: async () => { throw new Error('aborted') },
      },
    }
    const fn = wrapHeadlessPermissionFn(async () => ({
      behavior: 'ask',
      message: 'x',
    }))
    await expect(
      fn(
        makeTool('Bash') as any,
        { command: 'ls' },
        makeToolUseContext(new AbortController().signal) as any,
        {} as any,
        'tu-abort',
        undefined,
      ),
    ).rejects.toThrow('aborted')
  })
})
