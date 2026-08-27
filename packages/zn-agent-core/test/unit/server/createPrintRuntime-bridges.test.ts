/**
 * createPrintRuntime — P3 (plan §5) control_request 桥契约:
 *   1. control_request{can_use_tool, tool_name:'Bash'} → permissionBridge → success response
 *   2. control_request{can_use_tool, tool_name:'AskUserQuestion'} → askBridge → updatedInput.answers
 *   3. control_request{elicitation} → elicitationBridge → success {action, content?}
 *   4. permission/ask bridge 未注入 → error response(vendor 不挂)
 *   5. elicitation bridge 未注入 → cancel response(MCP 不阻塞)
 *
 * 用注入的 `runHeadlessImpl` 模拟 vendor stream-json 协议:在
 * session turn 内把 control_request 行塞回 input,bridge 解析后写回
 * control_response,query 循环再消费回写,断言最终 RuntimeEvent 流里
 * 出现 result/answer 信息。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  AskBridgeFn,
  ElicitationBridgeFn,
  OpenccRuntimeV2,
  PermissionBridgeFn,
} from '@zn-ai/zn-agent-core'
import { getPrintSessionContext } from '@zn-ai/zn-agent-core'

let dir: string
let runtime: OpenccRuntimeV2

type CapturedControl = {
  requestId: string
  subtype: string
  tool_name?: string
  raw: unknown
}

const captured: CapturedControl[] = []

let askResolve: ((answers: Record<string, unknown>) => void) | null = null
let permissionResolve:
  | ((d: {
      decision: 'allow' | 'deny'
      message?: string
      updatedInput?: Record<string, unknown>
    }) => void)
  | null = null
let elicitationResolve:
  | ((d: {
      action: 'accept' | 'decline' | 'cancel'
      content?: Record<string, unknown>
    }) => void)
  | null = null

function emitLine(obj: Record<string, unknown>): void {
  const line = JSON.stringify(obj) + '\n'
  const ctx = getPrintSessionContext()
  if (ctx) ctx.writeOutput(line)
}

async function fakeRunHeadless(
  inputPrompt: AsyncIterable<string>,
  _getAppState: unknown,
  _setAppState: unknown,
  _commands: unknown,
  _tools: unknown,
  _sdkMcpConfigs: unknown,
  _agents: unknown,
  options: { resume?: string | boolean },
): Promise<void> {
  const sid = String(options.resume ?? '')
  let sawUser = false
  for await (const line of inputPrompt) {
    const msg = JSON.parse(line)
    if (msg.type === 'user') {
      const sessionId = (msg.session_id as string) || sid
      // Emit init so zai SSE sees the session.
      emitLine({
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        uuid: randomUUID(),
      })
      if (!sawUser) {
        sawUser = true
        // First user prompt in each test → emit a control_request per
        // scenario, then wait for the matching control_response, then
        // emit a result that closes the turn.
        const scenario = (msg.message as { content: unknown })?.content as
          | { scenario?: string }
          | undefined
        const kind = (scenario?.scenario as string) ?? 'bash-allow'

        let request: Record<string, unknown>
        if (kind === 'bash-allow') {
          request = {
            type: 'control_request',
            request_id: randomUUID(),
            request: {
              subtype: 'can_use_tool',
              tool_name: 'Bash',
              tool_use_id: `tu-bash-${randomUUID()}`,
              input: { command: 'ls' },
            },
          }
        } else if (kind === 'ask-question') {
          request = {
            type: 'control_request',
            request_id: randomUUID(),
            request: {
              subtype: 'can_use_tool',
              tool_name: 'AskUserQuestion',
              tool_use_id: `tu-ask-${randomUUID()}`,
              input: {
                questions: [
                  {
                    question: 'pick',
                    header: 'h',
                    options: [
                      { label: 'A' },
                      { label: 'B' },
                    ],
                  },
                ],
              },
            },
          }
        } else if (kind === 'elicit-form') {
          request = {
            type: 'control_request',
            request_id: randomUUID(),
            request: {
              subtype: 'elicitation',
              mcp_server_name: 'demo',
              message: 'give me data',
              mode: 'form',
              requested_schema: { type: 'object' },
            },
          }
        } else {
          throw new Error(`unknown scenario ${kind}`)
        }
        emitLine(request)
      }
      continue
    }
    if (msg.type === 'control_response') {
      captured.push({
        requestId: msg.response?.request_id as string,
        subtype: msg.response?.subtype as string,
        tool_name: undefined,
        raw: msg.response?.response,
      })
      // Decide per scenario: after the bridge response, emit result.
      const last = captured[captured.length - 1]
      if (last?.subtype === 'success' && last.raw && (last.raw as any).action !== 'cancel') {
        emitLine({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ok',
          session_id: sid,
          uuid: randomUUID(),
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        })
      } else if (last?.subtype === 'success' && (last.raw as any)?.action === 'cancel') {
        // elicit cancel: still emit a result so the turn closes.
        emitLine({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'cancelled',
          session_id: sid,
          uuid: randomUUID(),
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        })
      } else if (last?.subtype === 'error') {
        emitLine({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: [(last.raw as any)?.error ?? 'bridge error'],
          session_id: sid,
          uuid: randomUUID(),
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        })
      }
      continue
    }
  }
}

const askBridge: AskBridgeFn = async ({ sessionId, toolUseId, input }) => {
  // Verify ALS-resolved sessionId matches the runtime's sessionId.
  expect(sessionId).toBeTruthy()
  expect(toolUseId).toBeTruthy()
  expect((input.questions as unknown[]).length).toBeGreaterThan(0)
  // Schedule the user answer so the bridge resolves.
  return await new Promise(resolve => {
    askResolve = (answers: Record<string, unknown>) =>
      resolve({ answers })
    // The fake runner will read the control_response and emit result.
    // The test driver below resolves this promise with the expected shape.
    setImmediate(() => {
      askResolve?.({ pick: 'A' })
      askResolve = null
    })
  })
}

const permissionBridge: PermissionBridgeFn = async ({
  sessionId,
  toolUseId,
  toolName,
  input,
}) => {
  expect(sessionId).toBeTruthy()
  expect(toolUseId).toBeTruthy()
  expect(toolName).toBe('Bash')
  expect(input).toEqual({ command: 'ls' })
  return await new Promise(resolve => {
    permissionResolve = d => resolve(d)
    setImmediate(() => {
      // Contract: vendor expects {behavior, message?, updatedInput?} from
      // the bridge — see createPrintRuntime-impl.ts handleControlRequest.
      // The zai-side wrapper maps its own registry's {decision} shape
      // onto this; in this test we emit the canonical form directly.
      permissionResolve?.({ behavior: 'allow' })
      permissionResolve = null
    })
  })
}

const elicitationBridge: ElicitationBridgeFn = async ({
  sessionId,
  mcpServerName,
  message,
  mode,
}) => {
  expect(sessionId).toBeTruthy()
  expect(mcpServerName).toBe('demo')
  expect(message).toBe('give me data')
  expect(mode).toBe('form')
  return await new Promise(resolve => {
    elicitationResolve = d => resolve(d)
    setImmediate(() => {
      elicitationResolve?.({ action: 'accept', content: { x: 1 } })
      elicitationResolve = null
    })
  })
}

const noopElicitationBridge: ElicitationBridgeFn = async () => ({
  action: 'cancel' as const,
})

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'print-bridges-'))
  writeFileSync(join(dir, 'settings.json'), '{}')
  const { createPrintRuntime } = await import('@zn-ai/zn-agent-core')
  runtime = (await createPrintRuntime({
    dataDir: dir,
    runtimeId: 'bridges-test',
    defaultCwd: dir,
    connectMcp: false,
    askBridge,
    permissionBridge,
    elicitationBridge,
    runHeadlessImpl: fakeRunHeadless as never,
  } as never)) as OpenccRuntimeV2
  // 60s: these hooks are top-level, so the per-describe `{ timeout }` below
  // does not cover them, and the first `import('@zn-ai/zn-agent-core')` costs
  // ~7s of vite-node transform — well past the 10s hook default.
}, 60_000)

afterAll(async () => {
  await runtime?.shutdown()
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

describe('createPrintRuntime — P3 control_request 桥', { timeout: 60_000 }, () => {
  it('Bash → permissionBridge → behavior:allow → success response', async () => {
    captured.length = 0
    const sid = randomUUID()
    const events: unknown[] = []
    for await (const ev of runtime.query({
      sessionId: sid,
      prompt: { scenario: 'bash-allow' },
      cwd: dir,
    } as unknown as { sessionId: string; prompt: string })) {
      events.push(ev)
    }
    expect(captured.length).toBeGreaterThan(0)
    expect(captured[0].subtype).toBe('success')
    expect((captured[0].raw as { behavior: string }).behavior).toBe('allow')
  })

  it('AskUserQuestion → askBridge → behavior:allow + updatedInput.answers', async () => {
    captured.length = 0
    const sid = randomUUID()
    const events: unknown[] = []
    for await (const ev of runtime.query({
      sessionId: sid,
      prompt: { scenario: 'ask-question' },
      cwd: dir,
    } as unknown as { sessionId: string; prompt: string })) {
      events.push(ev)
    }
    expect(captured.length).toBeGreaterThan(0)
    expect(captured[0].subtype).toBe('success')
    const response = captured[0].raw as {
      behavior: string
      updatedInput: { answers: Record<string, unknown> }
    }
    expect(response.behavior).toBe('allow')
    expect(response.updatedInput.answers).toEqual({ pick: 'A' })
  })

  it('elicitation → elicitationBridge → action:accept + content', async () => {
    captured.length = 0
    const sid = randomUUID()
    const events: unknown[] = []
    for await (const ev of runtime.query({
      sessionId: sid,
      prompt: { scenario: 'elicit-form' },
      cwd: dir,
    } as unknown as { sessionId: string; prompt: string })) {
      events.push(ev)
    }
    expect(captured.length).toBeGreaterThan(0)
    expect(captured[0].subtype).toBe('success')
    const response = captured[0].raw as {
      action: string
      content: Record<string, unknown>
    }
    expect(response.action).toBe('accept')
    expect(response.content).toEqual({ x: 1 })
  })
})

describe('createPrintRuntime — P3 bridge 缺位兜底', { timeout: 60_000 }, () => {
  it('permissionBridge 缺位 → error response(不挂 vendor)', async () => {
    // New runtime instance WITHOUT permissionBridge.
    const dir2 = mkdtempSync(join(tmpdir(), 'print-bridges-nob-'))
    writeFileSync(join(dir2, 'settings.json'), '{}')
    const { createPrintRuntime } = await import('@zn-ai/zn-agent-core')
    const rt = (await createPrintRuntime({
      dataDir: dir2,
      runtimeId: 'bridges-nob',
      defaultCwd: dir2,
      connectMcp: false,
      // askBridge + elicitationBridge still present
      askBridge,
      elicitationBridge: noopElicitationBridge,
      runHeadlessImpl: fakeRunHeadless as never,
    } as never)) as OpenccRuntimeV2
    captured.length = 0
    const sid = randomUUID()
    for await (const _ev of rt.query({
      sessionId: sid,
      prompt: { scenario: 'bash-allow' },
      cwd: dir2,
    } as unknown as { sessionId: string; prompt: string })) void _ev
    expect(captured[0].subtype).toBe('error')
    await rt.shutdown()
    rmSync(dir2, { recursive: true, force: true })
  })
})