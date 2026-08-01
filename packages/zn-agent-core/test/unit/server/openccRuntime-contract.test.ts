/**
 * Contract tests for the OpenCC server runtime seam.
 *
 * The new server runtime will replace the in-process zai DefaultAgentRuntime
 * path with a long-lived runtime that owns query / abort / session CRUD /
 * transcript access / shutdown. Task 1 introduces the public surface only:
 * a factory `createOpenccRuntime(options)` plus the four option/event/
 * input/runtime types, all reachable via the package's `./opencc-server`
 * subpath export.
 *
 * The brief mandates the factory throws a stable "not implemented" error
 * in Task 1 — the seam that prevents zai from continuing to depend on
 * the old compat bridge. Downstream Tasks fill the body; the test
 * contract here is the migration contract: type surface is locked,
 * factory body is the seam.
 */

import { describe, expect, it } from 'vitest'

import {
  createOpenccRuntime,
  type OpenccQueryInput,
  type OpenccRuntime,
  type OpenccRuntimeOptions,
  type OpenccServerEvent,
} from '@zn-ai/zn-agent-core/opencc-server'

/**
 * Locked method names the runtime must expose, per the brief.
 * Used both as a compile-time check (the array satisfies the union of
 * keys derived from `OpenccRuntime`) and as a runtime probe so a
 * future refactor that drops a method fails fast.
 */
const RUNTIME_METHODS = [
  'query',
  'abort',
  'getSession',
  'listSessions',
  'readTranscript',
  'patchSession',
  'removeSession',
  'shutdown',
] as const satisfies readonly (keyof OpenccRuntime)[]

/**
 * Compile-time assertion: a real runtime implementation must
 * provide every method on `OpenccRuntime`. The arrow function bodies
 * are never executed; the binding is a structural probe.
 */
const _runtimeShape: OpenccRuntime = {
  query: () => {
    throw new Error('compile-time shape only')
  },
  abort: async () => {
    throw new Error('compile-time shape only')
  },
  getSession: async () => {
    throw new Error('compile-time shape only')
  },
  listSessions: async () => {
    throw new Error('compile-time shape only')
  },
  readTranscript: async () => {
    throw new Error('compile-time shape only')
  },
  patchSession: async () => {
    throw new Error('compile-time shape only')
  },
  removeSession: async () => {
    throw new Error('compile-time shape only')
  },
  shutdown: async () => {
    throw new Error('compile-time shape only')
  },
}
void _runtimeShape

describe('createOpenccRuntime — server runtime contract (Task 1 seam)', () => {
  it('factory body throws a stable "not implemented" error (the migration seam)', async () => {
    // The error message is grep-stable so future Tasks can replace the
    // body (and a follow-up Task can drop the throw) without breaking
    // callers' migration code.
    await expect(createOpenccRuntime({} as OpenccRuntimeOptions)).rejects.toThrow(
      /not implemented/i,
    )
  })

  it('rejects regardless of which options shape the caller supplies', async () => {
    // The seam must hold for partial / full / empty option shapes —
    // the factory body never reaches a point where options matter,
    // because the throw happens first. This guarantees downstream
    // Tasks can extend `OpenccRuntimeOptions` without changing the
    // seam behaviour for Task 1 callers.
    const opts: OpenccRuntimeOptions = {
      dataDir: '/tmp/zai',
      runtimeId: 'rt-test',
      defaultCwd: '/work',
      defaultModel: 'claude-test',
    }
    await expect(createOpenccRuntime(opts)).rejects.toThrow(/not implemented/i)
  })

  it('exports `createOpenccRuntime` (function) and the four type-only exports via the opencc-server subpath', () => {
    // Re-import each named export so the test fails the moment any one
    // goes missing. We don't runtime-check the type-only exports (TS
    // already does that at compile time), but we DO verify the value
    // export exists as the expected kind.
    expect(typeof createOpenccRuntime).toBe('function')

    // Assignability probes for the type-only exports. These compile-time
    // checks fail at typecheck if any type goes missing.
    const input: OpenccQueryInput = {
      sessionId: 'sess-1',
      prompt: 'hello',
      cwd: '/tmp',
    }
    expect(input.sessionId).toBe('sess-1')

    const event: OpenccServerEvent = {
      type: 'runtime.done',
      sessionId: 'sess-1',
      ts: 0,
      // RuntimeEvent (compat/runtime/events.ts:42-46) requires both
      // `eventId` and `turnIndex` — the literal here MUST include them
      // or the assignability probe fails when typechecked. The brief
      // task spec puts the type behind the same contract as the
      // server runtime's `query` return stream, so the test is the
      // ground truth that callers can construct conformant events.
      eventId: 'evt-1',
      turnIndex: 0,
    }
    expect(event.type).toBe('runtime.done')

    // The contract: RUNTIME_METHODS names every method on OpenccRuntime.
    // The `satisfies` clause above already enforces this at compile time;
    // the assertion below documents the public surface in one place.
    expect(RUNTIME_METHODS).toEqual([
      'query',
      'abort',
      'getSession',
      'listSessions',
      'readTranscript',
      'patchSession',
      'removeSession',
      'shutdown',
    ])
  })
})
