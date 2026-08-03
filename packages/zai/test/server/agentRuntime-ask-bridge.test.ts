/**
 * AskUserQuestion bridge translation contract (agentRuntime.ts).
 *
 * The zai-native AskUserQuestion wrapper emits `tool_use:ask_pending`
 * (its own event vocabulary); the Web frontend only consumes
 * `prompt.ask` (useEventStream.ts dispatch). `bridgeAskPendingToPromptAsk`
 * performs that translation and pushes it through __zaiEventBus — the
 * side-channel that reaches the SSE stream while the query's for-await
 * is blocked on the tool's `await askRegistry.register(...)`.
 *
 * Regression guard for the "Agent 调用了 AskUserQuestion 但 UI 不弹框"
 * bug: without the static `__zaiBridgeCtx` injection
 * (askRegistry + onYield set by initAgentRuntime) and this translation,
 * the wrapper's askUserQuestionCall falls into its stub branch and the
 * QuestionCard never renders.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const BUS_KEY = '__zaiEventBus'
const BRIDGE_KEY = '__zaiBridgeCtx'

describe('agentRuntime — bridgeAskPendingToPromptAsk', () => {
  let savedBus: unknown
  let savedBridge: unknown

  beforeEach(() => {
    savedBus = (globalThis as any)[BUS_KEY]
    savedBridge = (globalThis as any)[BRIDGE_KEY]
  })

  afterEach(() => {
    if (savedBus === undefined) delete (globalThis as any)[BUS_KEY]
    else (globalThis as any)[BUS_KEY] = savedBus
    if (savedBridge === undefined) delete (globalThis as any)[BRIDGE_KEY]
    else (globalThis as any)[BRIDGE_KEY] = savedBridge
  })

  it('translates tool_use:ask_pending into prompt.ask on __zaiEventBus', async () => {
    // Import FIRST: agentRuntime.ts's module-level side effects set
    // __zaiEventBus / __zaiBridgeCtx on import; importing after
    // stubbing would overwrite the stubs.
    const mod = await import('../../src/server/services/agentRuntime.js')
    const emitted: unknown[] = []
    ;(globalThis as any)[BUS_KEY] = { emit: (e: unknown) => emitted.push(e) }
    ;(globalThis as any)[BRIDGE_KEY] = { sessionId: 'sess-ask-1' }

    mod.bridgeAskPendingToPromptAsk({
      type: 'tool_use:ask_pending',
      id: 'tu-1',
      questions: [
        {
          question: 'q?',
          header: 'h',
          options: [{ label: 'a' }, { label: 'b' }],
        },
      ],
      metadata: { source: 'test' },
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      type: 'prompt.ask',
      sessionId: 'sess-ask-1',
      toolUseId: 'tu-1',
      questions: [
        {
          question: 'q?',
          header: 'h',
          options: [{ label: 'a' }, { label: 'b' }],
        },
      ],
      metadata: { source: 'test' },
    })
  })

  it('uses toolUseId when the event only carries toolUseId (no id)', async () => {
    const mod = await import('../../src/server/services/agentRuntime.js')
    const emitted: unknown[] = []
    ;(globalThis as any)[BUS_KEY] = { emit: (e: unknown) => emitted.push(e) }
    ;(globalThis as any)[BRIDGE_KEY] = { sessionId: 'sess-ask-2' }

    mod.bridgeAskPendingToPromptAsk({
      type: 'tool_use:ask_pending',
      toolUseId: 'tu-2',
      questions: [],
    })

    expect(emitted).toHaveLength(1)
    expect((emitted[0] as { toolUseId?: string }).toolUseId).toBe('tu-2')
  })

  it('ignores non-ask_pending events and no-op without a bus', async () => {
    const mod = await import('../../src/server/services/agentRuntime.js')
    const emitted: unknown[] = []
    ;(globalThis as any)[BUS_KEY] = { emit: (e: unknown) => emitted.push(e) }
    ;(globalThis as any)[BRIDGE_KEY] = { sessionId: 'sess-ask-3' }

    mod.bridgeAskPendingToPromptAsk({ type: 'something.else' })
    mod.bridgeAskPendingToPromptAsk(undefined)
    expect(emitted).toHaveLength(0)

    // No __zaiEventBus → silent no-op (never throws).
    delete (globalThis as any)[BUS_KEY]
    expect(() =>
      mod.bridgeAskPendingToPromptAsk({
        type: 'tool_use:ask_pending',
        id: 'tu-3',
        questions: [],
      }),
    ).not.toThrow()
  })
})

describe('agentRuntime — bridgePermissionPendingToPromptPermission', () => {
  let savedBus: unknown
  let savedBridge: unknown

  beforeEach(() => {
    savedBus = (globalThis as any)[BUS_KEY]
    savedBridge = (globalThis as any)[BRIDGE_KEY]
  })

  afterEach(() => {
    if (savedBus === undefined) delete (globalThis as any)[BUS_KEY]
    else (globalThis as any)[BUS_KEY] = savedBus
    if (savedBridge === undefined) delete (globalThis as any)[BRIDGE_KEY]
    else (globalThis as any)[BRIDGE_KEY] = savedBridge
  })

  it('translates tool_use:permission_pending into prompt.permission on __zaiEventBus', async () => {
    const mod = await import('../../src/server/services/agentRuntime.js')
    const emitted: unknown[] = []
    ;(globalThis as any)[BUS_KEY] = { emit: (e: unknown) => emitted.push(e) }
    ;(globalThis as any)[BRIDGE_KEY] = { sessionId: 'sess-perm-1' }

    mod.bridgePermissionPendingToPromptPermission({
      type: 'tool_use:permission_pending',
      id: 'tu-perm-1',
      toolName: 'ExitPlanMode',
      description: 'Prompts the user to exit plan mode and start coding',
      input: { allowedPrompts: [] },
      message: 'Exit plan mode?',
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      type: 'prompt.permission',
      sessionId: 'sess-perm-1',
      toolUseId: 'tu-perm-1',
      toolName: 'ExitPlanMode',
      description: 'Prompts the user to exit plan mode and start coding',
      input: { allowedPrompts: [] },
      message: 'Exit plan mode?',
    })
  })

  it('ignores non-permission_pending events', async () => {
    const mod = await import('../../src/server/services/agentRuntime.js')
    const emitted: unknown[] = []
    ;(globalThis as any)[BUS_KEY] = { emit: (e: unknown) => emitted.push(e) }
    ;(globalThis as any)[BRIDGE_KEY] = { sessionId: 'sess-perm-2' }

    mod.bridgePermissionPendingToPromptPermission({ type: 'tool_use:ask_pending' })
    mod.bridgePermissionPendingToPromptPermission(undefined)
    expect(emitted).toHaveLength(0)
  })
})

describe('agentRuntime — bridgeToolYieldToPrompt dispatch', () => {
  let savedBus: unknown
  let savedBridge: unknown

  beforeEach(() => {
    savedBus = (globalThis as any)[BUS_KEY]
    savedBridge = (globalThis as any)[BRIDGE_KEY]
  })

  afterEach(() => {
    if (savedBus === undefined) delete (globalThis as any)[BUS_KEY]
    else (globalThis as any)[BUS_KEY] = savedBus
    if (savedBridge === undefined) delete (globalThis as any)[BRIDGE_KEY]
    else (globalThis as any)[BRIDGE_KEY] = savedBridge
  })

  it('routes ask_pending to prompt.ask and permission_pending to prompt.permission', async () => {
    const mod = await import('../../src/server/services/agentRuntime.js')
    const emitted: unknown[] = []
    ;(globalThis as any)[BUS_KEY] = { emit: (e: unknown) => emitted.push(e) }
    ;(globalThis as any)[BRIDGE_KEY] = { sessionId: 'sess-dispatch-1' }

    mod.bridgeToolYieldToPrompt({
      type: 'tool_use:ask_pending',
      id: 'tu-a',
      questions: [],
    })
    mod.bridgeToolYieldToPrompt({
      type: 'tool_use:permission_pending',
      id: 'tu-p',
      toolName: 'Bash',
      description: 'd',
      input: null,
      message: 'm',
    })
    mod.bridgeToolYieldToPrompt({ type: 'unknown.event' })

    expect(emitted.map((e) => (e as { type: string }).type)).toEqual([
      'prompt.ask',
      'prompt.permission',
    ])
    expect((emitted[1] as { toolUseId?: string }).toolUseId).toBe('tu-p')
  })
})
