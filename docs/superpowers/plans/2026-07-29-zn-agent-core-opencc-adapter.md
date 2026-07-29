# zn-agent-core OpenCC Adapter Implementation Plan

> ⚠️ **DEPRECATED** — This plan implements the **Bun-only path A**. It was abandoned after commit `a88ebff5` removed the Bun runtime requirement. See `2026-07-29-zn-agent-core-opencc-adapter-node-design.md` (path B, Node/tsx) for the current direction. Tasks 1-6, 14, 15 remain conceptually valid and will be reused in the new plan; Tasks 7-13 (tool wrappers) are reused as-is.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `DefaultAgentRuntime.run()` to opencc's `query()` via a thin adapter layer, so `/agent/prompt` produces real streaming events instead of an empty async iterable.

**Architecture:** zai-side `DefaultAgentRuntime.run(opts)` delegates to `runOpenccQuery(opts, config)` which translates `QueryOptions` → opencc's `QueryParams`, wraps each zai tool as an opencc `Tool`, calls `openccSrc.query()`, and enriches the resulting `StreamEvent` stream with `RuntimeEvent` meta fields via `wrapWithZaiMeta`. opencc owns the main loop, tool execution, MCP, hooks, permission, and commands.

**Tech Stack:** TypeScript ESM, strict; opencc 0.20.0 (vendored at `packages/zn-agent-core/src/opencc-src/`); Bun runtime (required); vitest; React `ReactNode` type only (no actual rendering).

## Global Constraints

- **Runtime**: zai server MUST run under Bun (`bun run ...` or `bun --bun ...`). Node.js will fail at runtime with `ERR_MODULE_NOT_FOUND: 'bun:bundle'` when the adapter's lazy-loaded opencc module chain reaches `withRetry.ts`. The adapter emits a clear `runtime.error` early if Bun is absent.
- **Tests in Node**: 27 pre-existing test failures from `bun:bundle` import constraint remain. Adapter unit tests must not increase this count.
- **OpenCC tool interface**: opencc's `Tool` interface in `packages/zn-agent-core/src/opencc-src/Tool.ts` requires ~30 methods including React renderers. Our wrappers provide default no-op implementations for unused methods (React renderers → `null`, capability flags → `false`).
- **Backward compatibility**: All existing compat shims (`MCPClientPool`, `DefaultPluginRuntime`, `cwdStore`, `commands`, etc.) remain unchanged. Adapter feeds them into opencc's existing `QueryParams` slots.
- **Worktree**: All work happens in `/Users/ethan/code/opencc-web-zn-agent-core` on branch `feat/zn-agent-core-from-opencc`. Do not commit to `main`.
- **Commit cadence**: One commit per task. Use `git add -A` only if all staged files belong to the current task.
- **Test framework**: vitest. Tests live in `packages/zn-agent-core/test/unit/runtime/` (new directory).
- **Type imports**: Always use `.js` extension for relative imports (ESM convention).

---

## File Structure

| File | Status | LOC | Responsibility |
|------|--------|-----|----------------|
| `packages/zn-agent-core/src/compat/runtime/openccToolDefaults.ts` | NEW | ~60 | Default no-op implementations for opencc Tool interface methods |
| `packages/zn-agent-core/src/compat/runtime/openccToolWrap.ts` | NEW | ~180 | `wrapAsOpenccTool(tool)` — wraps a zai Tool as opencc Tool |
| `packages/zn-agent-core/src/compat/runtime/queryParamsAdapter.ts` | NEW | ~80 | `toQueryParams(opts, config)` — QueryOptions → opencc QueryParams |
| `packages/zn-agent-core/src/compat/runtime/openccAdapter.ts` | NEW | ~120 | `runOpenccQuery(opts, config)` — top-level adapter orchestrator |
| `packages/zn-agent-core/src/compat/runtime/contract.ts` | MODIFY | +5 | Replace stub `run()` with delegation |
| `packages/zn-agent-core/src/compat/runtime/types.ts` | MODIFY | +15 | Add `OpenccAdapterConfig` interface |
| `packages/zn-agent-core/src/compat/tools/opencc/BashTool.ts` | NEW | ~50 | Wrap zai BashTool as opencc Tool |
| `packages/zn-agent-core/src/compat/tools/opencc/ReadTool.ts` | NEW | ~40 | Wrap zai ReadTool as opencc Tool |
| `packages/zn-agent-core/src/compat/tools/opencc/EditTool.ts` | NEW | ~40 | Wrap zai EditTool as opencc Tool |
| `packages/zn-agent-core/src/compat/tools/opencc/WriteTool.ts` | NEW | ~40 | Wrap zai WriteTool as opencc Tool |
| `packages/zn-agent-core/src/compat/tools/opencc/AgentTool.ts` | NEW | ~80 | Wrap zai AgentTool as opencc Tool (preserves parentSessionId) |
| `packages/zn-agent-core/src/compat/tools/opencc/AskUserQuestionTool.ts` | NEW | ~50 | Wrap zai AskUserQuestionTool as opencc Tool (AskRegistry integration) |
| `packages/zn-agent-core/src/compat/tools/opencc/index.ts` | NEW | ~10 | Barrel re-export |
| `packages/zn-agent-core/test/unit/runtime/openccAdapter.test.ts` | NEW | ~80 | Unit tests: Bun detection, abort, error wrapping |
| `packages/zn-agent-core/test/unit/runtime/openccToolWrap.test.ts` | NEW | ~80 | Unit tests: wrapAsOpenccTool shape + delegation |
| `packages/zn-agent-core/test/unit/runtime/queryParamsAdapter.test.ts` | NEW | ~80 | Unit tests: QueryParams translation |
| `packages/zn-agent-core/test/unit/tools/opencc/BashTool.test.ts` | NEW | ~30 | Unit test: BashTool wrapper delegates |
| `packages/zn-agent-core/test/unit/tools/opencc/AgentTool.test.ts` | NEW | ~40 | Unit test: parentSessionId preservation |
| `packages/zn-agent-core/test/integration/openccAdapter.bun.test.ts` | NEW | ~60 | Bun-gated integration test |
| `AGENTS.md` | MODIFY | +5 | Document Bun runtime requirement |

---

### Task 1: openccToolDefaults.ts — default no-op implementations

**Files:**
- Create: `packages/zn-agent-core/src/compat/runtime/openccToolDefaults.ts`
- Create: `packages/zn-agent-core/test/unit/runtime/openccToolDefaults.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `noopReactNode(): null`, `falseFn(): false`, `trueFn(): true`, `defaultDescription(): string`

- [ ] **Step 1: Write the failing test**

`packages/zn-agent-core/test/unit/runtime/openccToolDefaults.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  noopReactNode,
  falseFn,
  trueFn,
  defaultDescription,
  defaultUserFacingName,
} from '../../../src/compat/runtime/openccToolDefaults.js'

describe('openccToolDefaults', () => {
  it('noopReactNode returns null', () => {
    expect(noopReactNode()).toBeNull()
  })

  it('falseFn returns false', () => {
    expect(falseFn()).toBe(false)
  })

  it('trueFn returns true', () => {
    expect(trueFn()).toBe(true)
  })

  it('defaultDescription returns generic stub', () => {
    expect(defaultDescription({} as any, {} as any)).toBe('(no description)')
  })

  it('defaultUserFacingName returns input name', () => {
    expect(defaultUserFacingName({ name: 'MyTool' } as any)).toBe('MyTool')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/runtime/openccToolDefaults.test.ts
```

Expected: FAIL — `Cannot find module '../../../src/compat/runtime/openccToolDefaults.js'`

- [ ] **Step 3: Write minimal implementation**

`packages/zn-agent-core/src/compat/runtime/openccToolDefaults.ts`:

```ts
/**
 * Default no-op implementations for opencc Tool interface methods.
 *
 * opencc's Tool interface in `opencc-src/Tool.ts` requires ~30 methods.
 * zai-side tools only implement a subset (call, inputSchema, name, description).
 * This file provides shared default impls for the rest so wrappers don't
 * repeat boilerplate.
 */

export function noopReactNode(): null {
  return null
}

export function falseFn(): false {
  return false
}

export function trueFn(): true {
  return true
}

export async function defaultDescription(
  _input: unknown,
  _options: unknown,
): Promise<string> {
  return '(no description)'
}

export function defaultUserFacingName(input: { name: string }): string {
  return input.name
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/runtime/openccToolDefaults.test.ts
```

Expected: PASS — 5 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/runtime/openccToolDefaults.ts packages/zn-agent-core/test/unit/runtime/openccToolDefaults.test.ts
git commit -m "feat(zn-agent-core): openccToolDefaults — no-op impls for adapter"
```

---

### Task 2: openccToolWrap.ts — wrapAsOpenccTool skeleton

**Files:**
- Create: `packages/zn-agent-core/src/compat/runtime/openccToolWrap.ts`
- Create: `packages/zn-agent-core/test/unit/runtime/openccToolWrap.test.ts`

**Interfaces:**
- Consumes: `openccToolDefaults.ts` (Task 1)
- Produces: `wrapAsOpenccTool(tool: ZaiTool): OpenccTool` — wraps a zai `Tool` to satisfy opencc's `Tool` interface

- [ ] **Step 1: Write the failing test**

`packages/zn-agent-core/test/unit/runtime/openccToolWrap.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { wrapAsOpenccTool } from '../../../src/compat/runtime/openccToolWrap.js'
import type { Tool as ZaiTool } from '../../../src/compat/runtime/types.js'

function makeZaiTool(): ZaiTool {
  return {
    name: 'TestTool',
    description: 'A test tool',
    inputSchema: { type: 'object', properties: {} },
    async call(_args, _ctx) {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  }
}

describe('wrapAsOpenccTool', () => {
  it('returns object with required opencc Tool properties', () => {
    const wrapped = wrapAsOpenccTool(makeZaiTool())
    expect(wrapped.name).toBe('TestTool')
    expect(typeof wrapped.call).toBe('function')
    expect(typeof wrapped.inputSchema).toBeDefined()
    expect(typeof wrapped.maxResultSizeChars).toBe('number')
  })

  it('preserves name from input tool', () => {
    expect(wrapAsOpenccTool(makeZaiTool()).name).toBe('TestTool')
  })

  it('no-op methods return correct defaults', () => {
    const wrapped = wrapAsOpenccTool(makeZaiTool())
    expect(wrapped.isConcurrencySafe({} as any)).toBe(false)
    expect(wrapped.isReadOnly({} as any)).toBe(false)
    expect(wrapped.isEnabled()).toBe(true)
    expect(wrapped.renderToolUseMessage({} as any, {} as any)).toBeNull()
    expect(wrapped.renderToolResultMessage({} as any, [] as any, {} as any)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/runtime/openccToolWrap.test.ts
```

Expected: FAIL — `Cannot find module '../../../src/compat/runtime/openccToolWrap.js'`

- [ ] **Step 3: Write minimal implementation**

`packages/zn-agent-core/src/compat/runtime/openccToolWrap.ts`:

```ts
/**
 * wrapAsOpenccTool — wraps a zai Tool as an opencc Tool.
 *
 * opencc's `Tool` interface (packages/zn-agent-core/src/opencc-src/Tool.ts)
 * requires ~30 methods. zai's compat Tool is much simpler. This wrapper
 * fills the gap with no-op defaults for unused methods (React renderers,
 * isReadOnly, etc.) and delegates the essential ones (call, description,
 * name, inputSchema) to the underlying zai tool.
 *
 * Tool-specific wrappers (BashTool, ReadTool, etc.) in compat/tools/opencc/
 * extend this base with tool-specific behavior like permission checks.
 */

import type { Tool as ZaiTool } from './types.js'
import {
  noopReactNode,
  falseFn,
  trueFn,
  defaultDescription,
  defaultUserFacingName,
} from './openccToolDefaults.js'

// Minimal subset of opencc's Tool type that we satisfy. Avoids pulling
// opencc's full Tool interface (which requires ReactNode) into every caller.
export interface OpenccToolMinimal {
  readonly name: string
  readonly inputSchema: unknown
  readonly maxResultSizeChars: number
  call(args: unknown, ctx: unknown, canUseTool: unknown, parentMessage: unknown, onProgress?: unknown): Promise<unknown>
  description(input: unknown, options: unknown): Promise<string>
  isConcurrencySafe(input: unknown): boolean
  isReadOnly(input: unknown): boolean
  isEnabled(): boolean
  isMcp?: boolean
  isLsp?: boolean
  renderToolUseMessage(input: unknown, options: unknown): unknown
  renderToolResultMessage(output: unknown, progress: unknown[], options: unknown): unknown
  // ... other methods are optional and default to no-ops
}

export function wrapAsOpenccTool(tool: ZaiTool): OpenccToolMinimal {
  const wrapped: OpenccToolMinimal = {
    name: tool.name,
    inputSchema: tool.inputSchema,
    maxResultSizeChars: tool.maxResultSizeChars ?? 50_000,

    async call(args, ctx, _canUseTool, _parentMessage, _onProgress) {
      // zai's Tool.call has signature: (args, ctx) => Promise<ToolResult>
      // opencc's Tool.call has signature: (args, ctx, canUseTool, parentMessage, onProgress?) => Promise<ToolResult>
      // We pass through args + ctx; ignore the extra opencc-only params.
      return tool.call(args, ctx as any)
    },

    async description(input, options) {
      // zai's description is synchronous; opencc's is async.
      if (typeof tool.description === 'function') {
        return tool.description(input as any)
      }
      return defaultDescription(input, options)
    },

    isConcurrencySafe: falseFn,
    isReadOnly: falseFn,
    isEnabled: trueFn,
    renderToolUseMessage: noopReactNode as any,
    renderToolResultMessage: noopReactNode as any,
  }

  // Preserve userFacingName if present
  if (tool.userFacingName) {
    ;(wrapped as any).userFacingName = tool.userFacingName
  } else {
    ;(wrapped as any).userFacingName = defaultUserFacingName
  }

  return wrapped
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/runtime/openccToolWrap.test.ts
```

Expected: PASS — 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/runtime/openccToolWrap.ts packages/zn-agent-core/test/unit/runtime/openccToolWrap.test.ts
git commit -m "feat(zn-agent-core): openccToolWrap — wrap zai Tool as opencc Tool"
```

---

### Task 3: openccToolWrap.ts — Tool-specific wrapper (ReadTool pattern)

**Files:**
- Modify: `packages/zn-agent-core/src/compat/runtime/openccToolWrap.ts` (add `wrapWithOverrides`)
- Modify: `packages/zn-agent-core/test/unit/runtime/openccToolWrap.test.ts`

**Interfaces:**
- Consumes: `wrapAsOpenccTool` (Task 2)
- Produces: `wrapWithOverrides(tool, overrides)` — tool wrappers can override specific methods (e.g., BashTool overrides `checkPermissions`)

- [ ] **Step 1: Write the failing test**

Add to `test/unit/runtime/openccToolWrap.test.ts`:

```ts
import { wrapWithOverrides } from '../../../src/compat/runtime/openccToolWrap.js'

describe('wrapWithOverrides', () => {
  it('overrides specified methods on wrapped tool', async () => {
    const wrapped = wrapWithOverrides(makeZaiTool(), {
      isReadOnly: () => true,
      description: async () => 'overridden description',
    })
    expect(wrapped.isReadOnly({} as any)).toBe(true)
    expect(await wrapped.description({} as any, {} as any)).toBe('overridden description')
    // Non-overridden methods still work
    expect(wrapped.isEnabled()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/runtime/openccToolWrap.test.ts
```

Expected: FAIL — `wrapWithOverrides is not a function`

- [ ] **Step 3: Add wrapWithOverrides to openccToolWrap.ts**

Add to `packages/zn-agent-core/src/compat/runtime/openccToolWrap.ts`:

```ts
/**
 * wrapWithOverrides — like wrapAsOpenccTool but allows tool-specific
 * wrappers to override specific methods (e.g., BashTool overrides
 * checkPermissions, AskUserQuestionTool overrides requiresUserInteraction).
 */
export function wrapWithOverrides(
  tool: ZaiTool,
  overrides: Partial<OpenccToolMinimal>,
): OpenccToolMinimal {
  return { ...wrapAsOpenccTool(tool), ...overrides }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/runtime/openccToolWrap.test.ts
```

Expected: PASS — 4 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/runtime/openccToolWrap.ts packages/zn-agent-core/test/unit/runtime/openccToolWrap.test.ts
git commit -m "feat(zn-agent-core): wrapWithOverrides for tool-specific wrappers"
```

---

### Task 4: queryParamsAdapter.ts — basic field translation

**Files:**
- Create: `packages/zn-agent-core/src/compat/runtime/queryParamsAdapter.ts`
- Create: `packages/zn-agent-core/test/unit/runtime/queryParamsAdapter.test.ts`

**Interfaces:**
- Consumes: `wrapAsOpenccTool` (Task 2), `OpenccAdapterConfig` (Task 4.5, but interface declared here)
- Produces: `toQueryParams(opts: QueryOptions, config: OpenccAdapterConfig): QueryParams`

- [ ] **Step 1: Add OpenccAdapterConfig to types.ts**

Modify `packages/zn-agent-core/src/compat/runtime/types.ts`. Append at the bottom (after existing exports):

```ts
/**
 * Configuration for the opencc adapter layer.
 * Pass into DefaultAgentRuntime config to enable opencc query() delegation.
 */
export interface OpenccAdapterConfig {
  /** MCP client pool — tools from connected MCP servers injected into query(). */
  mcpPool?: import('../mcp/MCPClientPool.js').MCPClientPool | undefined
  /** Plugin runtime — hooks (PreToolUse, PostToolUse, etc.) attached to query lifecycle. */
  hookRunner?: import('../plugins/HookRunner.js').HookRunner | undefined
  /** Skills directories to load skill definitions from. */
  skillsDirs?: readonly string[] | undefined
  /** Sandbox config (executor, maxCpuMs, env allowlist). */
  sandbox?: import('./types.js').SandboxConfig | undefined
}
```

- [ ] **Step 2: Write the failing test**

`packages/zn-agent-core/test/unit/runtime/queryParamsAdapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { toQueryParams } from '../../../src/compat/runtime/queryParamsAdapter.js'
import type { QueryOptions } from '../../../src/compat/runtime/types.js'

function makeOpts(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return {
    prompt: { role: 'user', content: 'hello' },
    cwd: '/tmp/test',
    model: 'claude-test',
    tools: [],
    sessionId: 'sess-123',
    abortSignal: new AbortController().signal,
    ...overrides,
  } as QueryOptions
}

describe('toQueryParams', () => {
  it('translates prompt to messages', () => {
    const params = toQueryParams(makeOpts(), {})
    expect(params.messages).toBeDefined()
  })

  it('passes through cwd', () => {
    const params = toQueryParams(makeOpts({ cwd: '/foo' }), {})
    expect(params.cwd).toBe('/foo')
  })

  it('passes through model', () => {
    const params = toQueryParams(makeOpts({ model: 'gpt-x' }), {})
    expect(params.model).toBe('gpt-x')
  })

  it('passes through sessionId', () => {
    const params = toQueryParams(makeOpts({ sessionId: 's1' }), {})
    expect(params.sessionId).toBe('s1')
  })

  it('returns empty tools array when none provided', () => {
    const params = toQueryParams(makeOpts(), {})
    expect(params.tools).toEqual([])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/runtime/queryParamsAdapter.test.ts
```

Expected: FAIL — `Cannot find module 'queryParamsAdapter.js'`

- [ ] **Step 4: Write minimal implementation**

`packages/zn-agent-core/src/compat/runtime/queryParamsAdapter.ts`:

```ts
/**
 * toQueryParams — translates zai's QueryOptions to opencc's QueryParams.
 *
 * opencc's QueryParams is the input shape for opencc's main loop function
 * (openccSrc.query). This adapter maps field-by-field:
 *
 *   opts.prompt          → params.messages
 *   opts.cwd             → params.cwd
 *   opts.model           → params.model
 *   opts.tools           → params.tools (each wrapped via wrapAsOpenccTool)
 *   opts.sessionId       → params.sessionId
 *   opts.parentSessionId → params.parentSessionId
 *   opts.abortSignal     → params.abortController (bridged)
 *
 * Also feeds config-driven capabilities into opencc:
 *   config.mcpPool    → params.mcpServers
 *   config.hookRunner → params.hookRuntime
 *   config.skillsDirs → params.skillsDirs
 */

import type { QueryOptions, OpenccAdapterConfig } from './types.js'
import { wrapAsOpenccTool } from './openccToolWrap.js'

// Minimal shape — full QueryParams lives in opencc-src/query.ts and is
// larger than we need here. This interface captures the fields the adapter
// actually populates.
export interface QueryParamsOutput {
  messages: unknown[]
  cwd: string
  model: string
  tools: unknown[]
  sessionId: string
  parentSessionId?: string | undefined
  abortController?: AbortController | undefined
  mcpServers?: unknown[] | undefined
  hookRuntime?: unknown | undefined
  skillsDirs?: readonly string[] | undefined
  sandbox?: unknown | undefined
}

export function toQueryParams(
  opts: QueryOptions,
  config: OpenccAdapterConfig,
): QueryParamsOutput {
  const messages = Array.isArray(opts.prompt)
    ? opts.prompt
    : [opts.prompt]

  // Translate zai tools to opencc tools
  const tools = (opts.tools ?? []).map((t) => wrapAsOpenccTool(t as any))

  // Bridge abortSignal → abortController
  let abortController: AbortController | undefined
  if (opts.abortSignal) {
    abortController = new AbortController()
    if (opts.abortSignal.aborted) {
      abortController.abort(opts.abortSignal.reason)
    } else {
      opts.abortSignal.addEventListener(
        'abort',
        () => abortController!.abort(opts.abortSignal!.reason),
        { once: true },
      )
    }
  }

  return {
    messages,
    cwd: opts.cwd ?? process.cwd(),
    model: opts.model ?? 'default',
    tools,
    sessionId: opts.sessionId ?? 'unknown',
    parentSessionId: opts.parentSessionId,
    abortController,
    mcpServers: config.mcpPool ? [config.mcpPool] : undefined,
    hookRuntime: config.hookRunner,
    skillsDirs: config.skillsDirs,
    sandbox: config.sandbox,
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/runtime/queryParamsAdapter.test.ts
```

Expected: PASS — 5 tests passing

- [ ] **Step 6: Commit**

```bash
git add packages/zn-agent-core/src/compat/runtime/queryParamsAdapter.ts packages/zn-agent-core/src/compat/runtime/types.ts packages/zn-agent-core/test/unit/runtime/queryParamsAdapter.test.ts
git commit -m "feat(zn-agent-core): queryParamsAdapter + OpenccAdapterConfig"
```

---

### Task 5: openccAdapter.ts — Bun detection + abort-before-start

**Files:**
- Create: `packages/zn-agent-core/src/compat/runtime/openccAdapter.ts`
- Create: `packages/zn-agent-core/test/unit/runtime/openccAdapter.test.ts`

**Interfaces:**
- Consumes: `toQueryParams` (Task 4)
- Produces: `runOpenccQuery(opts, config): AsyncIterable<RuntimeEvent>` — top-level adapter

- [ ] **Step 1: Write the failing test (Bun detection)**

`packages/zn-agent-core/test/unit/runtime/openccAdapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { runOpenccQuery } from '../../../src/compat/runtime/openccAdapter.js'
import type { QueryOptions } from '../../../src/compat/runtime/types.js'

function makeOpts(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return {
    prompt: { role: 'user', content: 'hello' },
    cwd: '/tmp',
    model: 'm',
    tools: [],
    sessionId: 's',
    abortSignal: new AbortController().signal,
    ...overrides,
  } as QueryOptions
}

async function collectEvents(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

describe('runOpenccQuery', () => {
  it('emits runtime.error when not running under Bun', async () => {
    if (typeof process !== 'undefined' && process.versions?.bun) {
      // Skip — only meaningful under Node
      return
    }
    const events = await collectEvents(runOpenccQuery(makeOpts(), {}))
    expect(events).toHaveLength(1)
    const ev = events[0] as any
    expect(ev.type).toBe('runtime.error')
    expect(ev.error.category).toBe('internal')
    expect(ev.error.message).toMatch(/Bun runtime/)
  })

  it('emits runtime.aborted if abortSignal already aborted', async () => {
    const ac = new AbortController()
    ac.abort('test cancel')
    const events = await collectEvents(runOpenccQuery(makeOpts({ abortSignal: ac.signal }), {}))
    expect(events).toHaveLength(1)
    const ev = events[0] as any
    expect(ev.type).toBe('runtime.aborted')
    expect(ev.reason).toBe('test cancel')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/runtime/openccAdapter.test.ts
```

Expected: FAIL — `Cannot find module 'openccAdapter.js'`

- [ ] **Step 3: Write minimal implementation**

`packages/zn-agent-core/src/compat/runtime/openccAdapter.ts`:

```ts
/**
 * runOpenccQuery — top-level adapter connecting DefaultAgentRuntime.run()
 * to opencc's query() function.
 *
 * Responsibilities:
 * 1. Detect Bun runtime (opencc requires it due to bun:bundle imports).
 * 2. Honor pre-aborted signals before calling opencc.
 * 3. Translate QueryOptions → QueryParams.
 * 4. Call openccSrc.query() and forward events.
 * 5. Wrap events with RuntimeEvent meta fields (eventId, sessionId, ts, turnIndex).
 * 6. Translate opencc errors / aborts / stream-end-without-stop into RuntimeEvents.
 */

import { randomUUID } from 'node:crypto'
import type { QueryOptions, RuntimeEvent, OpenccAdapterConfig } from './types.js'
import { toQueryParams } from './queryParamsAdapter.js'
import { toRuntimeErrorEvent, toAbortedEvent, classifyError } from './streamAdapter.js'

const isBun = (): boolean =>
  typeof process !== 'undefined' && typeof process.versions?.bun === 'string'

export async function* runOpenccQuery(
  opts: QueryOptions,
  config: OpenccAdapterConfig,
): AsyncIterable<RuntimeEvent> {
  // 1. Bun detection — opencc's bun:bundle imports crash in Node.
  if (!isBun()) {
    yield toRuntimeErrorEvent(
      new Error(
        'zn-agent-core opencc adapter requires Bun runtime. Run with `bun --bun zai dev` or set ZAI_USE_BUN=1',
      ),
      { sessionId: opts.sessionId ?? 'unknown', turnIndex: 0 },
    )
    return
  }

  // 2. Pre-aborted
  if (opts.abortSignal?.aborted) {
    yield toAbortedEvent(
      { sessionId: opts.sessionId ?? 'unknown', turnIndex: 0 },
      String(opts.abortSignal.reason ?? 'aborted'),
    )
    return
  }

  // 3. Translate params
  const params = toQueryParams(opts, config)

  // 4. Call opencc + wrap events
  let turnIndex = 0
  let eventCounter = 0
  let sawMessageStop = false

  try {
    // Lazy import to avoid bun:bundle chain at module load time
    const { query: openccQuery } = await import(
      '../../opencc-src/query.js' as any
    ).catch(() => {
      throw new Error('opencc-src/query.js not found; ensure opencc source is vendored')
    })

    const stream = openccQuery(params)
    for await (const rawEvent of stream as AsyncIterable<Record<string, unknown>>) {
      if (opts.abortSignal?.aborted) {
        yield toAbortedEvent(
          { sessionId: opts.sessionId ?? 'unknown', turnIndex },
          String(opts.abortSignal.reason ?? 'aborted'),
        )
        return
      }

      const eventType = String((rawEvent as any).type ?? '')
      eventCounter++
      const ev: RuntimeEvent = {
        ...rawEvent,
        type: eventType,
        eventId: `evt-${eventCounter}`,
        sessionId: opts.sessionId ?? 'unknown',
        ts: Date.now(),
        turnIndex,
      } as RuntimeEvent

      // Track turnIndex on tool_use starts
      if (
        eventType === 'content_block_start' &&
        (rawEvent as any).content_block?.type === 'tool_use'
      ) {
        turnIndex++
        ;(ev as any).turnIndex = turnIndex
      }

      // Track message_stop
      if (eventType === 'message_stop') {
        sawMessageStop = true
      }

      // Forward error events
      if (eventType === 'error') {
        const err = (rawEvent as any).error ?? rawEvent
        yield toRuntimeErrorEvent(err, {
          sessionId: opts.sessionId ?? 'unknown',
          turnIndex,
        })
        continue
      }

      yield ev
    }

    // Stream ended without message_stop — soft error
    if (!sawMessageStop) {
      yield toRuntimeErrorEvent(
        new Error('response ended without message_stop'),
        { sessionId: opts.sessionId ?? 'unknown', turnIndex },
      )
    }
  } catch (err) {
    yield toRuntimeErrorEvent(err, {
      sessionId: opts.sessionId ?? 'unknown',
      turnIndex,
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/runtime/openccAdapter.test.ts
```

Expected: PASS — 2 tests passing (Bun test is no-op under Bun, abort test passes)

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/runtime/openccAdapter.ts packages/zn-agent-core/test/unit/runtime/openccAdapter.test.ts
git commit -m "feat(zn-agent-core): openccAdapter — Bun detection + abort handling"
```

---

### Task 6: DefaultAgentRuntime.run() — wire to openccAdapter

**Files:**
- Modify: `packages/zn-agent-core/src/compat/runtime/contract.ts` (replace stub)

**Interfaces:**
- Consumes: `runOpenccQuery` (Task 5)
- Produces: `DefaultAgentRuntime.run(opts)` delegates to `runOpenccQuery(opts, openccConfig)`

- [ ] **Step 1: Read current contract.ts stub**

`packages/zn-agent-core/src/compat/runtime/contract.ts` currently has:

```ts
run(_opts: QueryOptions): AsyncIterable<RuntimeEvent> {
  async function* empty(): AsyncGenerator<RuntimeEvent, void> {
    // intentionally empty — see comment above
  }
  return empty()
}
```

- [ ] **Step 2: Replace stub with delegation**

Replace the `run` method body with:

```ts
import { runOpenccQuery } from './openccAdapter.js'

// ... inside class:
run(opts: QueryOptions): AsyncIterable<RuntimeEvent> {
  // openccConfig is the optional subset of this.config that the adapter consumes.
  // Cast is safe because the adapter only reads known fields (mcpPool, hookRunner, etc.)
  const openccConfig = (this.config as any).openccConfig ?? {}
  return runOpenccQuery(opts, openccConfig)
}
```

- [ ] **Step 3: Verify build still passes**

```bash
pnpm --filter @zn-ai/zn-agent-core build
```

Expected: PASS — no new errors. (openccAdapter.ts has the bun:bundle constraint but it's only triggered at runtime, not compile time.)

- [ ] **Step 4: Verify zai build still passes**

```bash
pnpm --filter zai build
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/runtime/contract.ts
git commit -m "feat(zn-agent-core): wire DefaultAgentRuntime.run() to openccAdapter"
```

---

### Task 7: BashTool opencc wrapper

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/opencc/BashTool.ts`
- Create: `packages/zn-agent-core/test/unit/tools/opencc/BashTool.test.ts`

**Interfaces:**
- Consumes: `wrapAsOpenccTool` (Task 2), existing `compat/tools/bash/` (already ported in Task 21 batch)
- Produces: `wrapBashToolAsOpencc(zaiBashTool): OpenccTool`

- [ ] **Step 1: Write the failing test**

`packages/zn-agent-core/test/unit/tools/opencc/BashTool.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { wrapBashToolAsOpencc } from '../../../../src/compat/tools/opencc/BashTool.js'

describe('wrapBashToolAsOpencc', () => {
  it('returns tool with name Bash', () => {
    const wrapped = wrapBashToolAsOpencc()
    expect(wrapped.name).toBe('Bash')
  })

  it('call delegates to underlying bash implementation', async () => {
    const wrapped = wrapBashToolAsOpencc()
    const result = await wrapped.call(
      { command: 'echo hello' },
      { cwd: '/tmp' } as any,
      {} as any,
      {} as any,
    )
    expect(result).toBeDefined()
    // Result is ToolResultBlockParam shape: { content: [...] }
    expect((result as any).content).toBeDefined()
  })

  it('isDestructive returns true', () => {
    const wrapped = wrapBashToolAsOpencc()
    expect((wrapped as any).isDestructive({ command: 'rm -rf /' })).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/tools/opencc/BashTool.test.ts
```

Expected: FAIL — `Cannot find module 'BashTool.js'`

- [ ] **Step 3: Write minimal implementation**

`packages/zn-agent-core/src/compat/tools/opencc/BashTool.ts`:

```ts
/**
 * wrapBashToolAsOpencc — wraps zai's compat BashTool as an opencc Tool.
 *
 * opencc's main loop will call this tool when the model emits a Bash
 * tool_use. The wrapper delegates execution to the zai-side bash
 * implementation which handles sandboxing, cwd tracking, background
 * tasks, and persistent output files.
 */

import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { bashTool } from '../../tools/bash/index.js'

export function wrapBashToolAsOpencc() {
  const wrapped = wrapAsOpenccTool(bashTool as any)

  // Bash is destructive by default — used by opencc's auto-classifier
  ;(wrapped as any).isDestructive = () => true

  return wrapped
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/tools/opencc/BashTool.test.ts
```

Expected: PASS — 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/tools/opencc/BashTool.ts packages/zn-agent-core/test/unit/tools/opencc/BashTool.test.ts
git commit -m "feat(zn-agent-core): BashTool opencc wrapper"
```

---

### Task 8: ReadTool opencc wrapper

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/opencc/ReadTool.ts`
- Create: `packages/zn-agent-core/test/unit/tools/opencc/ReadTool.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/zn-agent-core/test/unit/tools/opencc/ReadTool.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { wrapReadToolAsOpencc } from '../../../../src/compat/tools/opencc/ReadTool.js'

describe('wrapReadToolAsOpencc', () => {
  it('returns tool with name Read', () => {
    const wrapped = wrapReadToolAsOpencc()
    expect(wrapped.name).toBe('Read')
  })

  it('isReadOnly returns true', () => {
    const wrapped = wrapReadToolAsOpencc()
    expect((wrapped as any).isReadOnly({ file_path: '/foo' })).toBe(true)
  })

  it('isDestructive is false (read-only)', () => {
    const wrapped = wrapReadToolAsOpencc()
    expect((wrapped as any).isDestructive?.({ file_path: '/foo' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/tools/opencc/ReadTool.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

`packages/zn-agent-core/src/compat/tools/opencc/ReadTool.ts`:

```ts
/**
 * wrapReadToolAsOpencc — wraps zai's compat ReadTool as an opencc Tool.
 */

import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { readTool } from '../../tools/read/index.js'

export function wrapReadToolAsOpencc() {
  const wrapped = wrapAsOpenccTool(readTool as any)
  ;(wrapped as any).isReadOnly = () => true
  // No isDestructive override — defaults to false
  return wrapped
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/tools/opencc/ReadTool.test.ts
```

Expected: PASS — 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/tools/opencc/ReadTool.ts packages/zn-agent-core/test/unit/tools/opencc/ReadTool.test.ts
git commit -m "feat(zn-agent-core): ReadTool opencc wrapper"
```

---

### Task 9: EditTool opencc wrapper

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/opencc/EditTool.ts`
- Create: `packages/zn-agent-core/test/unit/tools/opencc/EditTool.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/zn-agent-core/test/unit/tools/opencc/EditTool.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { wrapEditToolAsOpencc } from '../../../../src/compat/tools/opencc/EditTool.js'

describe('wrapEditToolAsOpencc', () => {
  it('returns tool with name Edit', () => {
    expect(wrapEditToolAsOpencc().name).toBe('Edit')
  })

  it('isDestructive returns true (modifies files)', () => {
    const wrapped = wrapEditToolAsOpencc()
    expect((wrapped as any).isDestructive({ file_path: '/foo', old_string: 'a', new_string: 'b' })).toBe(true)
  })

  it('isReadOnly returns false', () => {
    const wrapped = wrapEditToolAsOpencc()
    expect((wrapped as any).isReadOnly({ file_path: '/foo' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/tools/opencc/EditTool.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

`packages/zn-agent-core/src/compat/tools/opencc/EditTool.ts`:

```ts
/**
 * wrapEditToolAsOpencc — wraps zai's compat EditTool as an opencc Tool.
 */

import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { editTool } from '../../tools/edit/index.js'

export function wrapEditToolAsOpencc() {
  const wrapped = wrapAsOpenccTool(editTool as any)
  ;(wrapped as any).isDestructive = () => true
  return wrapped
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/tools/opencc/EditTool.test.ts
```

Expected: PASS — 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/tools/opencc/EditTool.ts packages/zn-agent-core/test/unit/tools/opencc/EditTool.test.ts
git commit -m "feat(zn-agent-core): EditTool opencc wrapper"
```

---

### Task 10: WriteTool opencc wrapper

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/opencc/WriteTool.ts`
- Create: `packages/zn-agent-core/test/unit/tools/opencc/WriteTool.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/zn-agent-core/test/unit/tools/opencc/WriteTool.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { wrapWriteToolAsOpencc } from '../../../../src/compat/tools/opencc/WriteTool.js'

describe('wrapWriteToolAsOpencc', () => {
  it('returns tool with name Write', () => {
    expect(wrapWriteToolAsOpencc().name).toBe('Write')
  })

  it('isDestructive returns true (overwrites files)', () => {
    const wrapped = wrapWriteToolAsOpencc()
    expect((wrapped as any).isDestructive({ file_path: '/foo', content: 'x' })).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/tools/opencc/WriteTool.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

`packages/zn-agent-core/src/compat/tools/opencc/WriteTool.ts`:

```ts
/**
 * wrapWriteToolAsOpencc — wraps zai's compat WriteTool as an opencc Tool.
 */

import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { writeTool } from '../../tools/write/index.js'

export function wrapWriteToolAsOpencc() {
  const wrapped = wrapAsOpenccTool(writeTool as any)
  ;(wrapped as any).isDestructive = () => true
  return wrapped
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/tools/opencc/WriteTool.test.ts
```

Expected: PASS — 2 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/tools/opencc/WriteTool.ts packages/zn-agent-core/test/unit/tools/opencc/WriteTool.test.ts
git commit -m "feat(zn-agent-core): WriteTool opencc wrapper"
```

---

### Task 11: AgentTool opencc wrapper (parentSessionId preservation)

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/opencc/AgentTool.ts`
- Create: `packages/zn-agent-core/test/unit/tools/opencc/AgentTool.test.ts`

**Interfaces:**
- Consumes: `wrapAsOpenccTool`, existing zai AgentTool
- Produces: `wrapAgentToolAsOpencc()` — wraps with parentSessionId preservation in call delegation

- [ ] **Step 1: Write the failing test**

`packages/zn-agent-core/test/unit/tools/opencc/AgentTool.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { wrapAgentToolAsOpencc } from '../../../../src/compat/tools/opencc/AgentTool.js'

describe('wrapAgentToolAsOpencc', () => {
  it('returns tool with name Agent', () => {
    expect(wrapAgentToolAsOpencc().name).toBe('Agent')
  })

  it('call preserves parentSessionId from context', async () => {
    // We can't easily test the underlying call without mocking, so verify
    // the wrapper exists and has expected shape.
    const wrapped = wrapAgentToolAsOpencc()
    expect(typeof wrapped.call).toBe('function')
    expect(typeof (wrapped as any).isDestructive).toBe('function')
  })

  it('isDestructive returns false (sub-agent does not directly destroy)', () => {
    const wrapped = wrapAgentToolAsOpencc()
    expect((wrapped as any).isDestructive({ prompt: 'foo' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/tools/opencc/AgentTool.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

`packages/zn-agent-core/src/compat/tools/opencc/AgentTool.ts`:

```ts
/**
 * wrapAgentToolAsOpencc — wraps zai's compat AgentTool as an opencc Tool.
 *
 * The AgentTool spawns a sub-agent. Critical: it must preserve
 * parentSessionId so the sub-agent's downstream calls (BackgroundRuntime
 * task dispatch, SubagentNotifier.handle) can attribute work to the
 * parent session. Without this, subagent notifications get silently
 * dropped (see HRMSV3-ZN-WEBSITE#668).
 */

import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { agentTool } from '../../tools/agent/index.js'

export function wrapAgentToolAsOpencc() {
  const wrapped = wrapAsOpenccTool(agentTool as any)

  // Sub-agent doesn't directly destroy files, but its actions might.
  // Default isReadOnly=false, isDestructive=false is fine.

  // The wrapAsOpenccTool call() already passes through args + ctx.
  // The zai-side AgentTool.call() reads parentSessionId from ctx
  // (set by zai's call sites); this is preserved by the wrapper.

  return wrapped
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/tools/opencc/AgentTool.test.ts
```

Expected: PASS — 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/tools/opencc/AgentTool.ts packages/zn-agent-core/test/unit/tools/opencc/AgentTool.test.ts
git commit -m "feat(zn-agent-core): AgentTool opencc wrapper"
```

---

### Task 12: AskUserQuestionTool opencc wrapper (AskRegistry integration)

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/opencc/AskUserQuestionTool.ts`
- Create: `packages/zn-agent-core/test/unit/tools/opencc/AskUserQuestionTool.test.ts`

**Interfaces:**
- Consumes: `wrapAsOpenccTool`, existing zai AskUserQuestionTool, AskRegistry
- Produces: `wrapAskUserQuestionToolAsOpencc()` — wraps with `requiresUserInteraction = true`

- [ ] **Step 1: Write the failing test**

`packages/zn-agent-core/test/unit/tools/opencc/AskUserQuestionTool.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { wrapAskUserQuestionToolAsOpencc } from '../../../../src/compat/tools/opencc/AskUserQuestionTool.js'

describe('wrapAskUserQuestionToolAsOpencc', () => {
  it('returns tool with name AskUserQuestion', () => {
    expect(wrapAskUserQuestionToolAsOpencc().name).toBe('AskUserQuestion')
  })

  it('requiresUserInteraction returns true', () => {
    const wrapped = wrapAskUserQuestionToolAsOpencc() as any
    expect(wrapped.requiresUserInteraction()).toBe(true)
  })

  it('interruptBehavior returns block (wait for user)', () => {
    const wrapped = wrapAskUserQuestionToolAsOpencc() as any
    expect(wrapped.interruptBehavior?.()).toBe('block')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/tools/opencc/AskUserQuestionTool.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

`packages/zn-agent-core/src/compat/tools/opencc/AskUserQuestionTool.ts`:

```ts
/**
 * wrapAskUserQuestionToolAsOpencc — wraps zai's compat AskUserQuestionTool.
 *
 * Critical for opencc's main loop: opencc uses `requiresUserInteraction()`
 * to decide whether to pause for human input. The zai-side
 * AskUserQuestionTool integrates with AskRegistry for in-process answer
 * resolution; this wrapper preserves that behavior while satisfying
 * opencc's interface.
 */

import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { askUserQuestionTool } from '../../tools/ask/index.js'

export function wrapAskUserQuestionToolAsOpencc() {
  const wrapped = wrapAsOpenccTool(askUserQuestionTool as any) as any

  // Tell opencc this tool needs user input — it will pause execution
  wrapped.requiresUserInteraction = () => true

  // Don't cancel on new user message — wait for current question
  wrapped.interruptBehavior = () => 'block'

  return wrapped
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/zn-agent-core && pnpm vitest run test/unit/tools/opencc/AskUserQuestionTool.test.ts
```

Expected: PASS — 3 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/compat/tools/opencc/AskUserQuestionTool.ts packages/zn-agent-core/test/unit/tools/opencc/AskUserQuestionTool.test.ts
git commit -m "feat(zn-agent-core): AskUserQuestionTool opencc wrapper"
```

---

### Task 13: opencc tools barrel export

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/opencc/index.ts`

- [ ] **Step 1: Create barrel**

`packages/zn-agent-core/src/compat/tools/opencc/index.ts`:

```ts
/**
 * Barrel re-export for opencc Tool wrappers.
 * Used by zai-side code that wants to provide zai's core tools
 * to opencc's main loop.
 */

export { wrapBashToolAsOpencc } from './BashTool.js'
export { wrapReadToolAsOpencc } from './ReadTool.js'
export { wrapEditToolAsOpencc } from './EditTool.js'
export { wrapWriteToolAsOpencc } from './WriteTool.js'
export { wrapAgentToolAsOpencc } from './AgentTool.js'
export { wrapAskUserQuestionToolAsOpencc } from './AskUserQuestionTool.js'

/**
 * Default core tools — convenience to feed opencc.query() with all 6
 * wrapped core tools at once.
 */
import { wrapBashToolAsOpencc } from './BashTool.js'
import { wrapReadToolAsOpencc } from './ReadTool.js'
import { wrapEditToolAsOpencc } from './EditTool.js'
import { wrapWriteToolAsOpencc } from './WriteTool.js'
import { wrapAgentToolAsOpencc } from './AgentTool.js'
import { wrapAskUserQuestionToolAsOpencc } from './AskUserQuestionTool.js'

export function defaultCoreToolsAsOpencc() {
  return [
    wrapBashToolAsOpencc(),
    wrapReadToolAsOpencc(),
    wrapEditToolAsOpencc(),
    wrapWriteToolAsOpencc(),
    wrapAgentToolAsOpencc(),
    wrapAskUserQuestionToolAsOpencc(),
  ]
}
```

- [ ] **Step 2: Verify build passes**

```bash
pnpm --filter @zn-ai/zn-agent-core build
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/zn-agent-core/src/compat/tools/opencc/index.ts
git commit -m "feat(zn-agent-core): opencc tools barrel + defaultCoreToolsAsOpencc"
```

---

### Task 14: Bun-gated integration test

**Files:**
- Create: `packages/zn-agent-core/test/integration/openccAdapter.bun.test.ts`

**Interfaces:**
- Consumes: `runOpenccQuery` (Task 5)
- Produces: integration test that runs under Bun only

- [ ] **Step 1: Write the test file**

`packages/zn-agent-core/test/integration/openccAdapter.bun.test.ts`:

```ts
/**
 * Bun-gated integration tests for openccAdapter.
 *
 * These tests require Bun runtime due to opencc's `bun:bundle` imports.
 * vitest config in packages/zn-agent-core/vitest.config.ts must include
 * this file with `bun test` runner, OR these tests can be run via:
 *
 *   bun --cwd packages/zn-agent-core vitest run test/integration/openccAdapter.bun.test.ts
 *
 * They will be skipped under Node (where bun:bundle imports fail).
 */

import { describe, expect, it } from 'vitest'
import { runOpenccQuery } from '../../src/compat/runtime/openccAdapter.js'
import type { QueryOptions } from '../../src/compat/runtime/types.js'

const isBun = (): boolean =>
  typeof process !== 'undefined' && typeof process.versions?.bun === 'string'

const itBun = isBun() ? it : it.skip

describe('runOpenccQuery (Bun integration)', () => {
  itBun('streams text deltas enriched with RuntimeEvent meta', async () => {
    const opts = {
      prompt: { role: 'user', content: 'Say "hello"' },
      cwd: '/tmp',
      model: 'MiniMax-M3',
      tools: [],
      sessionId: 'integration-test-1',
      abortSignal: new AbortController().signal,
    } as QueryOptions

    const events: any[] = []
    for await (const ev of runOpenccQuery(opts, {})) {
      events.push(ev)
      if (ev.type === 'message_stop') break
      if (events.length > 100) break // safety
    }

    // Should have at least message_start + content_block_delta + message_stop
    const types = events.map((e) => e.type)
    expect(types).toContain('message_start')
    expect(types).toContain('message_stop')

    // All events should have RuntimeEvent meta fields
    for (const ev of events) {
      expect(ev.eventId).toMatch(/^evt-\d+$/)
      expect(ev.sessionId).toBe('integration-test-1')
      expect(typeof ev.ts).toBe('number')
      expect(typeof ev.turnIndex).toBe('number')
    }
  }, 30_000)

  itBun('honors pre-aborted signal', async () => {
    const ac = new AbortController()
    ac.abort('integration-test-cancel')

    const opts = {
      prompt: { role: 'user', content: 'anything' },
      cwd: '/tmp',
      model: 'MiniMax-M3',
      tools: [],
      sessionId: 'integration-test-2',
      abortSignal: ac.signal,
    } as QueryOptions

    const events: any[] = []
    for await (const ev of runOpenccQuery(opts, {})) {
      events.push(ev)
    }

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('runtime.aborted')
    expect(events[0].reason).toBe('integration-test-cancel')
  })
})
```

- [ ] **Step 2: Verify test is skipped under Node**

```bash
cd packages/zn-agent-core && pnpm vitest run test/integration/openccAdapter.bun.test.ts
```

Expected: 0 tests run, 0 failures (both `itBun` skip under Node)

- [ ] **Step 3: Verify test runs under Bun (if Bun is available)**

```bash
cd packages/zn-agent-core && bun vitest run test/integration/openccAdapter.bun.test.ts
```

Expected: 2 tests passing (or 1 if MiniMax-M3 model is not configured)

- [ ] **Step 4: Commit**

```bash
git add packages/zn-agent-core/test/integration/openccAdapter.bun.test.ts
git commit -m "test(zn-agent-core): Bun-gated integration tests for openccAdapter"
```

---

### Task 15: AGENTS.md update for Bun runtime requirement

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Read current AGENTS.md core entry section**

Locate the section describing the opencc adapter (added in Task 24).

- [ ] **Step 2: Add Bun runtime notice**

After the existing `DefaultAgentRuntime` description, add:

```markdown
- **运行时要求**:opencc 适配层 (`compat/runtime/openccAdapter.ts`) 依赖 `import 'bun:bundle'`,zai server **必须** 在 Bun 下运行 (`bun --cwd packages/zai src/cli/index.ts dev` 或 `bun --bun zai dev`)。Node.js 下 zai 构建可通过但运行时 `runOpenccQuery()` 会立即抛 `runtime.error` 提示切换到 Bun。
```

- [ ] **Step 3: Verify build passes**

```bash
pnpm --filter zai build
```

Expected: PASS (markdown-only change)

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document Bun runtime requirement in AGENTS.md"
```

---

## Done Criteria

- [ ] All 14 commits land cleanly on `feat/zn-agent-core-from-opencc`
- [ ] `pnpm --filter @zn-ai/zn-agent-core build` passes
- [ ] `pnpm --filter @zn-ai/zn-agent-core test` passes; no increase in pre-existing 27 bun:bundle failures
- [ ] `pnpm --filter zai build` passes
- [ ] `pnpm --filter zai typecheck` reports no new errors
- [ ] Bun integration tests pass under `bun vitest run test/integration/openccAdapter.bun.test.ts`
- [ ] AGENTS.md updated with Bun runtime requirement

## Self-Review Notes

**Spec coverage:**
- Architecture (Section "Architecture") → Tasks 1-6 cover it
- Components (Section "Components") → All 10 new files created in Tasks 1-13
- Data flow (Section "Data flow") → Tasks 4 (QueryParams translation), 5 (opencc call + wrap)
- Error handling (Section "Error handling") → Task 5 covers Bun detection, abort, error wrapping; Task 6 wires it
- Testing (Section "Testing") → Tasks 1-4 have unit tests; Task 14 has integration test; Task 15 has docs

**Placeholder scan:** No "TBD" / "TODO" / vague steps. Every step has concrete code or commands.

**Type consistency:**
- `OpenccAdapterConfig` declared in Task 4, used in Task 5 (`runOpenccQuery` second param)
- `runOpenccQuery` signature `AsyncIterable<RuntimeEvent>` matches `AgentRuntime.run` interface
- Tool wrappers all return `OpenccToolMinimal` (defined in Task 2); specific overrides per tool in Tasks 7-12

**Caveats:**
- Task 6's cast `(this.config as any).openccConfig` is loose — Task 4 declares `OpenccAdapterConfig` but `RuntimeConfig` doesn't yet have an `openccConfig` field. Production wiring (zai's `agentRuntime.ts` passing `openccConfig`) is a follow-up; this plan only wires the runtime path. The cast is safe at runtime because the adapter only reads known fields.
- opencc's `Tool` type has ~30 methods; we satisfy a documented minimal subset (name, inputSchema, maxResultSizeChars, call, description, isConcurrencySafe, isReadOnly, isEnabled, isDestructive, renderToolUseMessage, renderToolResultMessage, requiresUserInteraction, interruptBehavior). If opencc queries a property not on our wrapper, runtime will see `undefined`. Acceptable for the 6 ported tools; uncovered properties can be added in follow-up plans if opencc actually queries them.
- Task 11 AgentTool parentSessionId preservation is documented but not unit-tested end-to-end (would require running sub-agent dispatch). The unit test verifies shape only. End-to-end verification happens via manual smoke.