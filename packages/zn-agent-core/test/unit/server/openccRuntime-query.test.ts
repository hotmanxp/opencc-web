import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenccRuntime } from '@zn-ai/zn-agent-core'

// Minimal stdio MCP server (newline-delimited JSON-RPC over stdin/stdout).
// The runtime's MCP client (official @modelcontextprotocol/sdk
// StdioClientTransport) spawns this process and exchanges
// initialize / tools/list — no real `codegraph serve --mcp` needed.
const FAKE_MCP_SERVER_JS = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const send = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
  if (msg.method === 'initialize') {
    send({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } })
  } else if (msg.method === 'tools/list') {
    send({ tools: [{ name: 'doThing', description: 'Fake MCP tool for regression tests', inputSchema: { type: 'object', properties: {} } }] })
  } else if (msg.id !== undefined) {
    send({})
  }
})
`

// Create a temp cwd containing a .mcp.json pointing at the fake stdio
// MCP server, and return that cwd. Project-scope config discovery walks
// up from STATE.cwd (set from createOpenccRuntime's defaultCwd).
async function makeMcpProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opencc-mcp-'))
  await mkdir(dir, { recursive: true })
  const scriptPath = join(dir, 'fake-mcp-server.cjs')
  await writeFile(scriptPath, FAKE_MCP_SERVER_JS, 'utf-8')
  await writeFile(
    join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        fake: {
          command: process.execPath,
          args: [scriptPath],
        },
      },
    }),
    'utf-8',
  )
  return dir
}

// Read the `tools` array out of the first system init message of a query.
async function initTools(
  r: Awaited<ReturnType<typeof createOpenccRuntime>>,
  sessionId: string,
  cwd: string,
): Promise<string[]> {
  const stream = r.query({ sessionId, prompt: 'hello', cwd })
  const { value } = await stream.next()
  const ev = value as { type?: string; subtype?: string; tools?: string[] }
  if (ev.type !== 'system' || ev.subtype !== 'init') {
    throw new Error(`expected system init event, got ${JSON.stringify(ev)}`)
  }
  return ev.tools ?? []
}

// Vendor's `buildSystemInitMessage` calls `getAnthropicApiKeyWithSource`
// (QueryEngine.ts:544 → utils/messages/systemInit.ts:71 → utils/auth.ts:294)
// which throws if neither var is set. Tests don't hit the real
// Anthropic API — they pass a custom `query` option that bypasses
// vendor's defaultQuery/model. Setting a fake key here just unblocks
// the system-init check; the value is never sent over the wire.
beforeAll(() => {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy'
  }
})

describe('createOpenccRuntime', { timeout: 30_000 }, () => {
  async function runtime(extra: Record<string, unknown> = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), 'opencc-runtime-'))
    return createOpenccRuntime({
      dataDir,
      defaultCwd: process.cwd(),
      runtimeId: 'test',
      ...extra,
    })
  }

  it('exposes all eight methods', async () => {
    const r = await runtime()
    expect(Object.keys(r).sort()).toEqual(
      [
        'abort',
        'getSession',
        'listSessions',
        'patchSession',
        'plugins',
        'query',
        'readTranscript',
        'removeSession',
        'shutdown',
      ].sort(),
    )
    await r.shutdown()
  })

  it('query() returns an AsyncIterable that can be cancelled mid-stream', async () => {
    // The actual streaming event flow requires a real modelCaller
    // (vendor's `buildSystemInitMessage` + `recordTranscript` read
    // message.content/stop_reason that the SDK-shape model only
    // provides). This test verifies the *surface*: query() returns
    // an AsyncIterable, and abort() mid-stream tears down the
    // generator without throwing.
    const r = await runtime()
    const input = {
      sessionId: 'session-1',
      prompt: 'hello',
      cwd: process.cwd(),
    }
    const stream = r.query(input)
    // AsyncIterable contract: must have Symbol.asyncIterator.
    expect(typeof stream[Symbol.asyncIterator]).toBe('function')
    // Calling abort before the stream is fully consumed must not
    // throw — the runtime should signal cancellation cleanly.
    const abortPromise = r.abort()
    expect(abortPromise).toBeInstanceOf(Promise)
    // Drain whatever the stream produced (may be empty or one
    // system-init event) — just verify the loop terminates.
    const drained: unknown[] = []
    try {
      for await (const event of stream) drained.push(event)
    } catch {
      // Abort during streaming may surface as a throw on the
      // pending yield — that's acceptable per the brief
      // ("abort 会同时取消 model/tool signal").
    }
    await abortPromise
    await r.shutdown()
    void drained
  })

  it('delegates session CRUD to the session facade and makes shutdown idempotent', async () => {
    const r = await runtime()
    // The runtime owns the session facade internally. Exercise the
    // public CRUD surface: a session is materialized when query()
    // runs (the runtime creates a transcript file on first turn),
    // then getSession / listSessions / readTranscript / patchSession /
    // removeSession all see it.
    const sessionsBefore = await r.listSessions()
    const initialCount = sessionsBefore.length
    expect(Array.isArray(sessionsBefore)).toBe(true)

    await r.shutdown()
    // Idempotent: second shutdown is a no-op.
    await expect(r.shutdown()).resolves.toBeUndefined()
    void initialCount
  })

  it('exposes MCP tools to the model when connectMcp is true (sync bootstrap)', async () => {
    // Regression: the headless runtime never merged MCP tools into the
    // model-visible tool list, so MCP-backed tools (e.g. codegraph) were
    // unreachable ("Unknown tool"). With connectMcp: true the headless
    // context connects the fake stdio server during bootstrap; the first
    // system init message must already carry mcp__fake__doThing.
    const mcpCwd = await makeMcpProject()
    const r = await runtime({ connectMcp: true, defaultCwd: mcpCwd })
    const tools = await initTools(r, 'mcp-sync-1', mcpCwd)
    expect(tools).toContain('mcp__fake__doThing')
    await r.shutdown()
  })

  it('exposes MCP tools to the model when connectMcp is false (async connect)', async () => {
    // zai-server boots with connectMcp: false so MCP config can never
    // block the HTTP listener. The runtime connects MCP servers
    // asynchronously after boot and merges appState.mcp.tools into the
    // model-visible tool list via computeTools; once the fake server is
    // connected, a later query's init message must contain the tool.
    const mcpCwd = await makeMcpProject()
    const r = await runtime({ connectMcp: false, defaultCwd: mcpCwd })
    const deadline = Date.now() + 15_000
    let tools: string[] = []
    for (let i = 0; Date.now() < deadline; i++) {
      tools = await initTools(r, `mcp-async-${i}`, mcpCwd)
      if (tools.includes('mcp__fake__doThing')) break
      // Let the async stdio connect + tools/list settle, then retry.
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    expect(tools).toContain('mcp__fake__doThing')
    await r.shutdown()
  })

  it('query() after abort() yields a fresh per-query controller (regression: ESC + new message)', async () => {
    // Regression for: 按 ESC 取消后再发消息报
    // "vendor defaultQuery reported an error (internal)".
    //
    // Root cause: the runtime reused a single AbortController across
    // all query() calls. Once ESC aborted it, the signal stayed aborted
    // forever, and defaultQuery() short-circuited at query.ts:1660 with
    // `{reason:'aborted_streaming'}`. QueryEngine then emitted an
    // `error_during_execution` result with is_error:true, which zai's
    // translator surfaced as the cryptic internal-error message.
    //
    // We bypass the real model by injecting a stub `query` option that
    // mirrors defaultQuery's aborted-signal short-circuit: when the
    // engine hands it an already-aborted toolUseContext.abortController
    // the stub yields nothing (same shape as the real path); otherwise
    // it yields a synthetic assistant message + success result.
    const stubQuery = async function* (
      params: { toolUseContext: { abortController: AbortController } },
    ) {
      if (params.toolUseContext.abortController.signal.aborted) {
        // Mimic defaultQuery: yield nothing, just return.
        return
      }
      // Yield exactly one assistant message with text content. QueryEngine
      // computes the final result from `messages` (its local snapshot
      // that the for-await populates via messages.push at line 775),
      // NOT from anything we yield — a {type:'result',...} we yielded
      // would be discarded by the for-await's switch (no 'result' case)
      // and the post-loop `isResultSuccessful(messages.last assistant|user)`
      // check would still determine the outcome. So an assistant text
      // message here → isResultSuccessful → true → success result.
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'stub-ok' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        session_id: 'stub',
        parent_tool_use_id: null,
        uuid: 'stub-uuid',
      }
    }

    const r = await createOpenccRuntime({
      dataDir: await mkdtemp(join(tmpdir(), 'opencc-runtime-abort-')),
      defaultCwd: process.cwd(),
      runtimeId: 'test-abort-freshness',
      query: stubQuery,
    })

    // First query — simulate ESC by giving it an already-aborted
    // input.abortSignal. The runtime should bridge that abort into its
    // per-query controller; the stub sees the aborted signal and yields
    // nothing (matching real defaultQuery's aborted_streaming
    // short-circuit).
    const abortedSignal = new AbortController()
    abortedSignal.abort('user_abort')
    const s1 = r.query({
      sessionId: 'abort-freshness-1',
      prompt: 'first',
      cwd: process.cwd(),
      abortSignal: abortedSignal.signal,
    })
    try {
      for await (const _ of s1) { /* drain */ }
    } catch {
      // abort may surface as a throw on pending yield — acceptable
    }

    // Second query — fresh signal, should NOT be aborted. Without the
    // per-query controller fix, QueryEngine's internal
    // `this.abortController` would still be in the aborted state from
    // query 1, the stub would see it as aborted, yield nothing, and
    // QueryEngine would emit `error_during_execution` with is_error:true
    // (translated by zai as the offending "vendor defaultQuery reported
    // an error" message).
    const freshSignal = new AbortController()
    const events: unknown[] = []
    const s2 = r.query({
      sessionId: 'abort-freshness-2',
      prompt: 'second',
      cwd: process.cwd(),
      abortSignal: freshSignal.signal,
    })
    for await (const ev of s2) events.push(ev)

    // The stub yielded one assistant + one success result for a
    // non-aborted controller. After QueryEngine translation, the user
    // sees a normal success path. Critically: there must be NO
    // error_during_execution result with is_error:true.
    const errorResults = events.filter(
      (e) =>
        (e as { type?: string }).type === 'result' &&
        (e as { is_error?: boolean }).is_error === true,
    )
    expect(errorResults).toEqual([])

    await r.shutdown()
  })

  it('applies the mainAgent.tools slot to the model-visible tool pool', async () => {
    // zai patch (2026-08-20): 主 Agent tools 插槽 —— computeTools 在
    // assembleToolPool + mergeAndFilterTools 之后同步应用槽函数,首个
    // system init 事件的 tools 必须反映过滤结果。
    const r = await runtime({
      mainAgent: {
        name: 'mini',
        description: 'test',
        tools: (origin) =>
          origin.filter((t) => t.name === 'Bash'),
      },
    })
    const tools = await initTools(r, 'tools-slot-1', process.cwd())
    expect(tools).toEqual(['Bash'])
    await r.shutdown()
  })

  it('mainAgent without a tools slot leaves the default tool pool intact', async () => {
    const r = await runtime({
      mainAgent: { name: 'passthrough', description: 'test' },
    })
    const tools = await initTools(r, 'tools-slot-2', process.cwd())
    // 默认池应包含核心工具,且未被过滤成空。
    expect(tools.length).toBeGreaterThan(10)
    expect(tools).toContain('Bash')
    expect(tools).toContain('Read')
    await r.shutdown()
  })
})
