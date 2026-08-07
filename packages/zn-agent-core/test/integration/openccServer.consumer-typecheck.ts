/**
 * Package-consumer typecheck for `@zn-ai/zn-agent-core/opencc-server`.
 *
 * This file is the consumer-side mirror of the contract test in
 * `test/unit/server/openccRuntime-contract.test.ts`. The contract test
 * typechecks against the package source (`src/opencc-src/server/*`) via
 * the `tsconfig.contract-tests.json` build; THIS file typechecks against
 * the BUILT package (`dist/opencc-src/server/*`) via
 * `tsconfig.consumer.json`. The two must agree — if the source types
 * compile but the built d.ts does not (because the build dropped a
 * dependency, drifted a re-export, etc.), the consumer typecheck catches
 * it before the package is published.
 *
 * NOTE: the file is intentionally named `*.consumer-typecheck.ts` (NOT
 * `*.test.ts`) so the vitest `include` glob (`test/<dir>/<name>.test.ts`)
 * does not pick it up. The file has no `describe` / `it` blocks — it is
 * a pure type-level probe driven by `tsc --noEmit` via the
 * `typecheck:consumer` npm script. Running it under vitest would fail
 * with "No test suite found in file"; the `test` script in package.json
 * therefore skips it.
 *
 * These are pure type-level assertions — no runtime expectations. As
 * long as `tsc --noEmit -p tsconfig.consumer.json` exits 0, the consumer
 * can:
 *   - import the seven public types and the factory
 *   - construct a concrete-shape `OpenccServerEvent` literal
 *   - construct a concrete-shape `OpenccTranscriptMeta` literal
 *   - implement the eight-method `OpenccRuntime` interface
 *   - call `createOpenccRuntime` with the required `dataDir` option
 *   - subscribe to the `AsyncIterable<OpenccServerEvent>` returned by `query`
 * All without single-module imports from outside the `./opencc-server`
 * subpath. If the publisher ever silently re-introduces a `compat/*`
 * import in the published d.ts, the resolve path will fail because
 * `dist/compat/transcript/types.js` does not exist; the consumer
 * typecheck would fail-fast with TS2307.
 *
 * This file is intentionally import-only — no `describe` / `it` blocks.
 * The runtime assertion is `tsc --noEmit` itself, which the npm script
 * `typecheck:consumer` runs. The fold-empty IIFEs at the bottom are
 * the structural probes that drive the compile-time checks.
 */

import {
  createOpenccRuntime,
  type OpenccPermissionMode,
  type OpenccQueryInput,
  type OpenccRuntime,
  type OpenccRuntimeOptions,
  type OpenccServerEvent,
  type OpenccTranscriptFile,
  type OpenccTranscriptMeta,
} from '@zn-ai/zn-agent-core/opencc-server'

// ── Value export: factory is a function ──────────────────────────────
const _factoryIsFunction: typeof createOpenccRuntime = createOpenccRuntime
void _factoryIsFunction

// ── Type exports: each must be assignable to `unknown` ───────────────
const _typeAliases = [
  null as unknown as OpenccPermissionMode,
  null as unknown as OpenccQueryInput,
  null as unknown as OpenccRuntime,
  null as unknown as OpenccRuntimeOptions,
  null as unknown as OpenccServerEvent,
  null as unknown as OpenccTranscriptFile,
  null as unknown as OpenccTranscriptMeta,
]
void _typeAliases

// ── OpenccServerEvent literal: must satisfy the required-fields contract
//    (no compat-runtime import needed by the consumer).
const _event: OpenccServerEvent = {
  type: 'runtime.done',
  sessionId: 'sess-1',
  ts: 0,
  eventId: 'evt-1',
  turnIndex: 0,
  // Provider-specific payload hangs off the open-ended index sig.
  text: 'hello',
} as OpenccServerEvent
void _event

// ── OpenccTranscriptMeta literal: must satisfy the public shape.
const _meta: OpenccTranscriptMeta = {
  version: 2,
  transcriptId: 'tx-1',
  cwd: '/tmp',
  model: 'm',
  createdAt: 0,
  updatedAt: 0,
  messageCount: 0,
  // Optional fields omitted to prove they remain optional.
}
void _meta

// ── OpenccTranscriptFile literal: must satisfy the public shape.
const _file: OpenccTranscriptFile = {
  version: 2,
  transcriptId: 'tx-1',
  meta: _meta,
  messages: [],
}
void _file

// ── Constraint: getSession return type is `OpenccTranscriptMeta | null`.
async function _listSessionsProbe(rt: OpenccRuntime): Promise<OpenccTranscriptMeta[]> {
  return await rt.listSessions({ cwd: '/tmp', includeSubagent: false })
}
void _listSessionsProbe

async function _getSessionProbe(rt: OpenccRuntime): Promise<OpenccTranscriptMeta | null> {
  return await rt.getSession('sess-1')
}
void _getSessionProbe

async function _readTranscriptProbe(
  rt: OpenccRuntime,
): Promise<OpenccTranscriptFile> {
  return await rt.readTranscript('sess-1', { cwd: '/tmp' })
}
void _readTranscriptProbe

// ── Structural probe: implement every method on `OpenccRuntime`.
const _runtimeShape: OpenccRuntime = {
  query: (_input: OpenccQueryInput): AsyncIterable<OpenccServerEvent> => {
    return (async function* () {
      yield {
        type: 'runtime.done',
        sessionId: _input.sessionId,
        ts: 0,
        eventId: 'evt-1',
        turnIndex: 0,
      } as OpenccServerEvent
    })()
  },
  abort: async () => undefined,
  getSession: async () => null,
  listSessions: async () => [],
  readTranscript: async () => _file,
  patchSession: async () => undefined,
  removeSession: async () => undefined,
  shutdown: async () => undefined,
  plugins: {
    listInstalled: async () => ({ plugins: [], errors: [] }),
    listAvailable: async () => [],
    setEnabled: async () => ({ success: true, message: 'ok' }),
    install: async () => ({ success: true, message: 'ok' }),
    uninstall: async () => ({ success: true, message: 'ok' }),
    update: async () => ({ success: true, message: 'ok' }),
    listMarketplaces: async () => [],
    addMarketplace: async () => ({ success: true, message: 'ok' }),
    reload: async () => ({ success: true, message: 'ok' }),
  },
}
void _runtimeShape

// ── Factory call: options must satisfy `OpenccRuntimeOptions`
//    (dataDir required, others optional).
const _factoryCall = (): Promise<OpenccRuntime> => {
  return createOpenccRuntime({
    dataDir: '/tmp/zai',
    runtimeId: 'rt-consumer',
    defaultCwd: '/work',
    defaultModel: 'claude-test',
  })
}
void _factoryCall

// ── It is acceptable to pass a runtime ID without `defaultCwd`/`defaultModel`.
const _factoryCallMinimal = (): Promise<OpenccRuntime> => {
  return createOpenccRuntime({ dataDir: '/tmp/zai' })
}
void _factoryCallMinimal
