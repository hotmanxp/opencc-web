import { describe, expect, it } from 'vitest'
import { wrapAsOpenccTool, wrapWithOverrides } from '../../../src/compat/runtime/openccToolWrap.js'
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
  it('uses function description directly when provided', async () => {
    const tool = makeZaiTool()
    tool.description = () => 'sync description'
    const wrapped = wrapAsOpenccTool(tool)
    const result = await wrapped.description({}, undefined)
    expect(result).toBe('sync description')
  })

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

describe('wrapAsOpenccTool — call wraps result in ToolResult envelope', () => {
  // Regression: vendor tools' call() returns ToolResult<Output> which is
  // {data: Output, newMessages?, contextModifier?, mcpMeta?} (opencc-src/
  // Tool.ts:358). opencc's toolExecution.ts reads result.data directly
  // for analytics logging (line 1542-1544) and feeds it into
  // mapToolResultToToolResultBlockParam (line 1573). The wrapper
  // previously returned the bare zai output ({output: string}) — so
  // result.data was undefined, mapToolResult produced an empty
  // tool_result, and the LLM stopped after AskUserQuestion (UI shows
  // "completed with no output"). Fix: wrap the zai output in
  // {data: ...} inside wrapAsOpenccTool.call.
  it('wraps bare zai output {output: string} in {data: ...}', async () => {
    const tool: ZaiTool = {
      name: 'Echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: {} },
      async call(_args, _ctx) {
        return { output: 'hello world' }
      },
    }
    const wrapped: any = wrapAsOpenccTool(tool)
    const result = await wrapped.call({}, {} as any, undefined, undefined, undefined)
    expect(result).toEqual({ data: { output: 'hello world' } })
  })

  it('forwards an already-ToolResult-shaped value verbatim', async () => {
    const tool: ZaiTool = {
      name: 'Advanced',
      description: 'advanced',
      inputSchema: { type: 'object', properties: {} },
      async call(_args, _ctx) {
        return { data: { output: 'ok' }, newMessages: [] } as any
      },
    }
    const wrapped: any = wrapAsOpenccTool(tool)
    const result = await wrapped.call({}, {} as any, undefined, undefined, undefined)
    expect(result).toEqual({ data: { output: 'ok' }, newMessages: [] })
  })

  it('downstream mapToolResultToToolResultBlockParam extracts data.output correctly', async () => {
    const tool: ZaiTool = {
      name: 'Ask',
      description: 'ask',
      inputSchema: { type: 'object', properties: {} },
      async call(_args, _ctx) {
        return { output: 'User has answered: Q? -> A' }
      },
    }
    const wrapped: any = wrapAsOpenccTool(tool)
    // Simulate the opencc flow: tool.call → result.data → mapToolResult
    const result = await wrapped.call({}, {} as any, undefined, undefined, undefined)
    const block = wrapped.mapToolResultToToolResultBlockParam(result.data, 'tu-1')
    expect(block).toEqual({
      type: 'tool_result',
      content: 'User has answered: Q? -> A',
      tool_use_id: 'tu-1',
    })
  })
})

describe('wrapAsOpenccTool — mapToolResultToToolResultBlockParam', () => {
  // Regression: opencc's toolExecution.ts:1573 calls this method
  // unconditionally after every tool call. The wrapper previously did
  // not expose it, so every wrapped zai-native tool (AskUserQuestion,
  // TaskCreate/Update/List/Get, Skill) threw
  // "mapToolResultToToolResultBlockParam is not a function" the
  // moment opencc tried to format their output for the next LLM turn.
  it('is a function on every wrapped tool', () => {
    const wrapped: any = wrapAsOpenccTool(makeZaiTool())
    expect(typeof wrapped.mapToolResultToToolResultBlockParam).toBe('function')
  })

  it('unwraps the zai ToolResult {output: string} shape', () => {
    const wrapped: any = wrapAsOpenccTool(makeZaiTool())
    const block = wrapped.mapToolResultToToolResultBlockParam(
      { output: 'User has answered: Q1? -> A1' },
      'tu-1',
    )
    expect(block).toEqual({
      type: 'tool_result',
      content: 'User has answered: Q1? -> A1',
      tool_use_id: 'tu-1',
    })
  })

  it('passes a raw string through unchanged', () => {
    const wrapped: any = wrapAsOpenccTool(makeZaiTool())
    expect(
      wrapped.mapToolResultToToolResultBlockParam('hello', 'tu-2'),
    ).toEqual({
      type: 'tool_result',
      content: 'hello',
      tool_use_id: 'tu-2',
    })
  })

  it('serializes structured output via JSON.stringify', () => {
    const wrapped: any = wrapAsOpenccTool(makeZaiTool())
    expect(
      wrapped.mapToolResultToToolResultBlockParam({ id: 't1', status: 'completed' }, 'tu-3'),
    ).toEqual({
      type: 'tool_result',
      content: '{"id":"t1","status":"completed"}',
      tool_use_id: 'tu-3',
    })
  })

  it('handles null/undefined data with empty content', () => {
    const wrapped: any = wrapAsOpenccTool(makeZaiTool())
    expect(wrapped.mapToolResultToToolResultBlockParam(null, 'tu-4')).toEqual({
      type: 'tool_result',
      content: '',
      tool_use_id: 'tu-4',
    })
    expect(wrapped.mapToolResultToToolResultBlockParam(undefined, 'tu-5')).toEqual({
      type: 'tool_result',
      content: '',
      tool_use_id: 'tu-5',
    })
  })

  it('does NOT set is_error (zai signals errors via [error] prefix in output string)', () => {
    const wrapped: any = wrapAsOpenccTool(makeZaiTool())
    const block = wrapped.mapToolResultToToolResultBlockParam(
      { output: '[error] task not found: t1' },
      'tu-6',
    )
    // Setting is_error would make Anthropic treat the tool as a hard
    // failure rather than a recoverable output. zai's convention is to
    // embed the [error] marker inside the output string; the LLM reads
    // it as feedback.
    expect(block).not.toHaveProperty('is_error')
  })
})

describe('wrapAsOpenccTool — toAutoClassifierInput', () => {
  // The vendor's DefaultableToolKeys lists toAutoClassifierInput as a
  // defaultable key (Tool.ts:750), but wrapAsOpenccTool doesn't go
  // through buildTool, so we supply the same default `() => ''` to
  // keep the YOLO auto-classifier (yoloClassifier.ts:429) from blowing
  // up. Returning '' tells the classifier to skip this tool.
  it('returns empty string (skip the auto-classifier)', () => {
    const wrapped: any = wrapAsOpenccTool(makeZaiTool())
    expect(wrapped.toAutoClassifierInput({ command: 'rm -rf /' })).toBe('')
  })
})

describe('wrapAsOpenccTool — prompt', () => {
  // Regression: opencc's toolToAPISchema (utils/api.ts:221) calls
  // `tool.prompt(options)` for EVERY tool on EVERY API request. The
  // wrapper previously did not expose this method, so every API call
  // threw `tool.prompt is not a function` before the LLM even saw the
  // tool list. zai tools carry static descriptions and don't use
  // vendor's context-aware prompt rendering, so the default returns
  // the static description string verbatim.
  it('returns the static description string from the zai tool', async () => {
    const tool = makeZaiTool()
    tool.description = 'Static description of TestTool'
    const wrapped: any = wrapAsOpenccTool(tool)
    await expect(
      wrapped.prompt({
        getToolPermissionContext: async () => ({}),
        tools: [],
        agents: [],
      }),
    ).resolves.toBe('Static description of TestTool')
  })

  it('forwards through function-shaped descriptions', async () => {
    const tool = makeZaiTool()
    tool.description = (_input: unknown, _opts: unknown) => 'dynamic'
    const wrapped: any = wrapAsOpenccTool(tool)
    await expect(
      wrapped.prompt({
        getToolPermissionContext: async () => ({}),
        tools: [],
        agents: [],
      }),
    ).resolves.toBe('dynamic')
  })

  it('falls back to "(no description)" when description is missing', async () => {
    const tool = makeZaiTool()
    tool.description = undefined
    const wrapped: any = wrapAsOpenccTool(tool)
    await expect(
      wrapped.prompt({
        getToolPermissionContext: async () => ({}),
        tools: [],
        agents: [],
      }),
    ).resolves.toBe('(no description)')
  })
})

describe('wrapAsOpenccTool — description returns static text', () => {
  // Regression: the wrapper's description() previously fell through to
  // defaultDescription() when tool.description was a string (the zai-
  // native shape — compat/tools/index.ts:431-488 all use a static
  // string). That made the MCP tool detail view (MCPToolDetailView.
  // tsx:71) and the canUseTool confirmation dialog (useCanUseTool.tsx:
  // 57) render "(no description)" for every wrapped zai-native tool
  // — silently stripping the description that the LLM and the user
  // both rely on. The fix mirrors the new prompt() default below.
  it('returns the static description string verbatim', async () => {
    const tool = makeZaiTool()
    tool.description = 'Execute a shell command…'
    const wrapped = wrapAsOpenccTool(tool)
    await expect(
      wrapped.description({}, {
        isNonInteractiveSession: false,
        toolPermissionContext: {},
        tools: [],
      }),
    ).resolves.toBe('Execute a shell command…')
  })

  it('still forwards through function-shaped descriptions', async () => {
    const tool = makeZaiTool()
    tool.description = (input: unknown) => `dyn(${JSON.stringify(input)})`
    const wrapped = wrapAsOpenccTool(tool)
    await expect(wrapped.description({ foo: 1 }, {} as any)).resolves.toBe(
      'dyn({"foo":1})',
    )
  })
})

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

  it('still exposes mapToolResultToToolResultBlockParam after override', () => {
    const wrapped: any = wrapWithOverrides(makeZaiTool(), {
      isReadOnly: () => true,
    })
    expect(typeof wrapped.mapToolResultToToolResultBlockParam).toBe('function')
    expect(
      wrapped.mapToolResultToToolResultBlockParam({ output: 'ok' }, 'tu-x'),
    ).toEqual({
      type: 'tool_result',
      content: 'ok',
      tool_use_id: 'tu-x',
    })
  })
})
