/**
 * Failure tests for the headless OpenCC context factory.
 *
 * Task 2 extracts a `createHeadlessContext(options)` from the vendor
 * CLI bootstrap (`cli/print.ts runHeadless`, `entrypoints/cli.tsx main`,
 * `setup.ts`). The factory must build a fully-initialized headless
 * OpenCC context — settings, AppState, default tools, permission
 * harness, hooks/plugins, MCP clients, sandbox, sessions — keyed by
 * the caller's explicit `cwd`/`dataDir`/`runtimeId` so multiple server
 * contexts in the same process do not share or overwrite each other's
 * global STATE.
 *
 * Coverage per the brief:
 *   1. config readable (settings + global config load without throwing)
 *   2. cwd is the one we passed in (not process.cwd(), not stale)
 *   3. non-interactive client type (server never has TTY)
 *   4. default tools exist (built-in registry resolves)
 *   5. AppState store does NOT pull Ink / React / ReactDOM
 *   6. same process, two different cwds → two distinct contexts
 *
 * Step 1 of Task 2: write these tests FIRST so the brief's failure
 * path (Step 2 — Run tests and capture the first missing
 * exports/state leak) is real, not decorative.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHeadlessContext } from '@zn-ai/zn-agent-core/opencc-server'

describe('createHeadlessContext — vendor headless bootstrap (Task 2)', () => {
  let dataDir: string
  let cwdA: string
  let cwdB: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'zai-headless-data-'))
    cwdA = mkdtempSync(join(tmpdir(), 'zai-headless-cwdA-'))
    cwdB = mkdtempSync(join(tmpdir(), 'zai-headless-cwdB-'))
    // Pin the settings path so `enableConfigs()` reads/writes under our
    // temp dataDir rather than touching ~/.zai. Each test gets a fresh
    // directory, so the settings file must be created here or the
    // vendor's `getGlobalConfig` falls back to defaults at the real
    // home directory.
    writeFileSync(
      join(dataDir, 'settings.json'),
      JSON.stringify({
        // minimal valid settings shape; zai-server doesn't depend on
        // any specific settings key to bootstrap the AppState store.
        env: {},
      }),
      'utf8',
    )
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(cwdA, { recursive: true, force: true })
    rmSync(cwdB, { recursive: true, force: true })
  })

  it('returns a context with the documented shape (config, appState, tools, permission, hooks, mcp, sandbox, sessions)', async () => {
    const ctx = await createHeadlessContext({
      cwd: cwdA,
      dataDir,
      runtimeId: 'rt-test-shape',
    })

    // Every documented key must be present and not null/undefined.
    // Using `expect(ctx.X).toBeDefined()` keeps the failure message
    // actionable when one of the keys goes missing.
    expect(ctx.config, 'ctx.config').toBeDefined()
    expect(ctx.appState, 'ctx.appState').toBeDefined()
    expect(ctx.tools, 'ctx.tools').toBeDefined()
    expect(ctx.permission, 'ctx.permission').toBeDefined()
    expect(ctx.hooks, 'ctx.hooks').toBeDefined()
    expect(ctx.mcp, 'ctx.mcp').toBeDefined()
    expect(ctx.sandbox, 'ctx.sandbox').toBeDefined()
    expect(ctx.sessions, 'ctx.sessions').toBeDefined()
  })

  it('config is readable (vendor settings loaded without throwing)', async () => {
    const ctx = await createHeadlessContext({
      cwd: cwdA,
      dataDir,
      runtimeId: 'rt-test-config',
    })

    // `ctx.config` should expose the loaded settings + global config.
    // We don't assert the inner shape (Task 1's contract test already
    // locks the public type surface); we only assert that the value
    // is a non-null object that the caller can read.
    expect(ctx.config).toBeTypeOf('object')
    expect(ctx.config).not.toBeNull()

    // The vendor's settings load must have run during bootstrap — if
    // `enableConfigs()` was skipped, the first getConfig() call would
    // throw inside the AppState getDefaultAppState() path. The fact
    // that createHeadlessContext returned at all means the load ran.
    expect(ctx.config.dataDir).toBe(dataDir)
  })

  it('cwd is set to the value the caller passed (not process.cwd(), not stale)', async () => {
    const ctx = await createHeadlessContext({
      cwd: cwdA,
      dataDir,
      runtimeId: 'rt-test-cwd',
    })

    // The brief: "Context 中所有状态按 cwd、dataDir、session 显式传递,
    // 不读取 CLI 当前 session singleton". config.cwd must echo the
    // caller's cwd so downstream Task 4 can wrap QueryEngine.query()
    // with runWithSdkContext({ cwd }, ...) instead of relying on the
    // global STATE.cwd singleton.
    expect(ctx.config.cwd).toBe(cwdA)
  })

  it('non-interactive client type — server never has a TTY', async () => {
    const ctx = await createHeadlessContext({
      cwd: cwdA,
      dataDir,
      runtimeId: 'rt-test-noninteractive',
    })

    // Two surfaces assert the headless contract:
    //   (a) ctx.config.clientType === 'zai-server' (or other server-
    //       surfaced marker) — vendor branches on clientType in
    //       ~17 places (auth preference, analytics, settings sources).
    //   (b) ctx.config.isInteractive === false — vendor's
    //       getIsNonInteractiveSession() reads STATE.isInteractive;
    //       ~83 call sites take the headless branch when true.
    expect(ctx.config.clientType).toBe('zai-server')
    expect(ctx.config.isInteractive).toBe(false)
  })

  it('default tools exist — built-in tool registry resolves to a non-empty list', async () => {
    const ctx = await createHeadlessContext({
      cwd: cwdA,
      dataDir,
      runtimeId: 'rt-test-tools',
    })

    // The brief mandates "默认 tools 存在" — built-in tools such as
    // Bash, Read, Write, Edit, Glob, Grep must be in the registry.
    // Vendor's `Tools` type is `readonly Tool[]` (opencc-src/Tool.ts:738),
    // so we map to names before asserting. We don't hard-code the exact
    // name list (vendor can add more); we assert the registry is
    // non-empty AND contains at least the canonical Bash/Read names
    // that any reasonable built-in set has.
    const tools = ctx.tools ?? []
    expect(Array.isArray(tools), 'ctx.tools must be an array').toBe(true)
    const toolNames = tools.map((t: { name: string }) => t.name)
    expect(toolNames.length).toBeGreaterThan(0)
    expect(toolNames).toContain('Bash')
    expect(toolNames).toContain('Read')
  })

  it('AppState is a plain store (no Ink / React / ReactDOM dependency)', async () => {
    const ctx = await createHeadlessContext({
      cwd: cwdA,
      dataDir,
      runtimeId: 'rt-test-appstate',
    })

    // The brief: "AppState 不加载 Ink". The store surface is exactly
    // { getState, setState, subscribe } — no React/Ink rendering API.
    const store = ctx.appState
    expect(typeof store.getState).toBe('function')
    expect(typeof store.setState).toBe('function')
    expect(typeof store.subscribe).toBe('function')

    // `getState()` returns a plain object — the AppState shape — with
    // the canonical fields getDefaultAppState() initialises. We check
    // a couple of well-known fields to prove we're not handing back
    // an empty object or a React element.
    const initial = store.getState()
    expect(initial).toBeTypeOf('object')
    expect(initial).not.toBeNull()
    // AppState.settings is the user/settings.json content (or empty
    // defaults if the file is missing). Either way it must be defined.
    expect(initial.settings).toBeDefined()

    // Sanity: store must NOT expose React/Ink surface.
    // AppState stores never expose `render`, `Component`, `createElement`,
    // or `JSX`; the explicit `.not` checks below catch any future
    // refactor that accidentally pulls React into the server path.
    const storeAsAny = store as unknown as Record<string, unknown>
    expect(storeAsAny.render, 'store.render must be undefined').toBeUndefined()
    expect(
      storeAsAny.Component,
      'store.Component must be undefined',
    ).toBeUndefined()
    expect(
      storeAsAny.createElement,
      'store.createElement must be undefined',
    ).toBeUndefined()
  })

  it('two contexts in the same process with different cwds do not overwrite each other', async () => {
    const ctxA = await createHeadlessContext({
      cwd: cwdA,
      dataDir,
      runtimeId: 'rt-test-isolation-A',
    })
    const ctxB = await createHeadlessContext({
      cwd: cwdB,
      dataDir,
      runtimeId: 'rt-test-isolation-B',
    })

    // Each context must remember its own cwd. The default zai
    // synthetic runtime writes through to global STATE.cwd, so the
    // second createHeadlessContext overwrites the first — that's the
    // multi-session race the brief calls out.
    expect(ctxA.config.cwd).toBe(cwdA)
    expect(ctxB.config.cwd).toBe(cwdB)

    // AppState stores must be distinct object identities — they hold
    // session-scoped state (tasks, notifications, mcp clients) that
    // would otherwise bleed across sessions if shared.
    expect(ctxA.appState).not.toBe(ctxB.appState)
    expect(ctxA.tools).not.toBe(ctxB.tools)

    // After creating B, A's cwd must still be A's cwd — not silently
    // mutated by B's bootstrap. This is the explicit-isolation check.
    expect(ctxA.config.cwd).toBe(cwdA)
  })
})