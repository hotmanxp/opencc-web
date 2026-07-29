import { describe, expect, mock, test } from 'bun:test'
import {
  handleInteractivePermission,
  type InteractivePermissionParams,
} from './interactiveHandler.js'

// Pin the watchdog pause/resume wiring: resume must fire exactly once per
// terminal path (including aborts and setup throws), so a future path that
// bypasses resolveOnce fails here instead of silently stranding the watchdog.

type QueueItem = {
  onAbort: () => void
  onAllow: (
    updatedInput: Record<string, unknown>,
    permissionUpdates: unknown[],
    feedback?: string,
  ) => Promise<void>
  onReject: (feedback?: string) => void
}

function setup(opts?: {
  preAbort?: boolean
  throwOnPush?: boolean
  bridge?: unknown
}) {
  // Plain (non-idempotent) spy: a double-call fails the exactly-once assertions,
  // so the handler can't lean on QueryGuard's internal idempotence.
  const resume = mock()
  const beginUserInteraction = mock(() => resume)
  let queueItem: QueueItem | undefined

  const abortController = new AbortController()
  if (opts?.preAbort) abortController.abort()

  const ctx = {
    tool: { name: 'Bash', requiresUserInteraction: () => false },
    input: {},
    assistantMessage: { message: { id: 'msg-1' } },
    toolUseID: 'tu-1',
    toolUseContext: {
      queryActivity: {
        registerActivity: mock(),
        acquireLease: mock(() => ({ id: '', release() {} })),
        beginUserInteraction,
      },
      abortController,
      getAppState: () => ({
        toolPermissionContext: { mode: 'default' },
        mcp: { clients: [] },
      }),
    },
    pushToQueue: mock((item: QueueItem) => {
      if (opts?.throwOnPush) throw new Error('setup boom')
      queueItem = item
    }),
    removeFromQueue: mock(),
    updateQueueItem: mock(),
    logDecision: mock(),
    logCancelled: mock(),
    handleUserAllow: mock(async () => ({ behavior: 'allow' })),
    cancelAndAbort: mock(() => ({ behavior: 'deny' })),
    buildAllow: mock((input: Record<string, unknown>) => ({
      behavior: 'allow',
      updatedInput: input,
    })),
    persistPermissions: mock(),
    runHooks: mock(async () => null),
  }

  const resolve = mock()
  const params = {
    ctx,
    description: 'desc',
    result: { behavior: 'ask' },
    // Skip the async hook/classifier races so only the dialog callbacks resolve.
    awaitAutomatedChecksBeforeDialog: true,
    bridgeCallbacks: opts?.bridge,
    channelCallbacks: undefined,
  } as unknown as InteractivePermissionParams

  let thrownError: unknown
  try {
    handleInteractivePermission(params, resolve)
  } catch (e) {
    thrownError = e
  }

  return {
    ctx,
    resume,
    beginUserInteraction,
    resolve,
    abortController,
    thrownError,
    getQueueItem: () => queueItem as QueueItem,
  }
}

describe('handleInteractivePermission watchdog suspension', () => {
  test('suspends once when the dialog is shown, before any resolution', () => {
    const { beginUserInteraction, resume } = setup()
    expect(beginUserInteraction).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
  })

  test('resumes exactly once on allow', async () => {
    const { getQueueItem, resume, resolve } = setup()
    await getQueueItem().onAllow({}, [])
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  test('resumes exactly once on reject', () => {
    const { getQueueItem, resume, resolve } = setup()
    getQueueItem().onReject('no thanks')
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  test('resumes exactly once on abort', () => {
    const { getQueueItem, resume, resolve } = setup()
    getQueueItem().onAbort()
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  test('resumes only once when two resolution paths race', async () => {
    const { getQueueItem, resume, resolve } = setup()
    getQueueItem().onReject('first')
    await getQueueItem().onAllow({}, []) // loses the claim
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  test('resumes before awaiting post-approval async work', () => {
    const { ctx, getQueueItem, resume } = setup()
    let releaseAllow: (() => void) | undefined
    ctx.handleUserAllow = mock(
      () =>
        new Promise(res => {
          releaseAllow = () => res({ behavior: 'allow' })
        }),
    )
    void getQueueItem().onAllow({}, []) // handleUserAllow stays pending
    expect(resume).toHaveBeenCalledTimes(1)
    releaseAllow?.()
  })

  test('resumes even when allow processing throws', async () => {
    const { ctx, getQueueItem, resume } = setup()
    ctx.handleUserAllow = mock(async () => {
      throw new Error('persist failed')
    })
    await expect(getQueueItem().onAllow({}, [])).rejects.toThrow('persist failed')
    expect(resume).toHaveBeenCalledTimes(1)
  })

  test('resolves, resumes, and dequeues when aborted outside the dialog callbacks', () => {
    const { ctx, abortController, resume, resolve } = setup()
    expect(resume).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    abortController.abort()
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
    // Stale prompt must be removed from the queue on external abort.
    expect(ctx.removeFromQueue).toHaveBeenCalledTimes(1)
  })

  test('resolves and resumes immediately if already aborted when shown', () => {
    const { ctx, resume, resolve } = setup({ preAbort: true })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
    // Must not enqueue a prompt that is immediately stale.
    expect(ctx.pushToQueue).not.toHaveBeenCalled()
  })

  test('cancels the remote bridge prompt on external abort', () => {
    const bridge = {
      sendRequest: mock(),
      onResponse: mock(() => () => {}),
      cancelRequest: mock(),
      sendResponse: mock(),
    }
    const { abortController } = setup({ bridge })
    abortController.abort()
    expect(bridge.cancelRequest).toHaveBeenCalledTimes(1)
  })

  test('abort after a normal resolution does not double-resolve or double-resume', () => {
    const { abortController, getQueueItem, resume, resolve } = setup()
    getQueueItem().onReject('no')
    abortController.abort()
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  test('resumes, rethrows, and cleans up if dialog setup throws synchronously', () => {
    const { ctx, abortController, resume, resolve, thrownError } = setup({
      throwOnPush: true,
    })
    expect(thrownError).toBeInstanceOf(Error)
    expect((thrownError as Error).message).toBe('setup boom')
    expect(resume).toHaveBeenCalledTimes(1)
    // catch path dequeues the (partially) pushed prompt...
    expect(ctx.removeFromQueue).toHaveBeenCalled()
    // ...and detaches the abort listener, so a later abort cannot re-fire it.
    const resolveCallsBefore = resolve.mock.calls.length
    abortController.abort()
    expect(resolve.mock.calls.length).toBe(resolveCallsBefore)
  })
})
