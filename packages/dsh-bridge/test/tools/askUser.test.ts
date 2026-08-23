/**
 * askUser tool + provider 单元测试 — P-AskUserQuestion。
 *
 * 覆盖:
 *   1. registerAskUserProvider 在 fake ctx 上注册,zai sink 真的被 ctx.userQuestions
 *      service 拿到(后续 ask() 会路由到它)。
 *   2. registerAskUserTool 把 AskUserQuestion 注册到 ctx.tools,定义名对齐
 *      opencc vendor(`AskUserQuestion`)。
 *   3. tool.execute 内部调 ctx.userQuestions.ask,把 upstream answer 按 id
 *      还原成 {question, header, selected, custom?} 形态。
 *   4. EMPTY_QUESTIONS 防御:execute 入口空 questions 抛错,符合
 *      `ask_user_question requires at least one question` 文案。
 *   5. 信号透传:execute 收到 exec.signal 透传给 provider 的 ask(req)。
 *   6. provider dispose 后 userQuestions 不再路由到该 sink。
 *
 * 不依赖 dsh 真实 runtime — 用 fake ctx + fake userQuestions service。
 */
import { describe, it, expect, vi } from 'vitest'
import { parameterSchemaSpecToJsonSchema, validateArgs, ToolArgsError } from '@deepseek-ai/dsh-tools'
import {
  registerAskUserProvider,
  registerAskUserTool,
} from '../../src/tools/askUser.js'

/**
 * 构造最小 fake ctx,带 `userQuestions` 和 `tools` service。
 *
 * `tools.register` 接受 dsh `ToolDefinition`(defineTool 返回值),返回 disposer。
 * 这里把 definition 缓存到外层数组,测试可以 inspect。
 */
function makeFakeCtx() {
  const toolDefs: unknown[] = []
  const userQuestions = {
    registerProvider: vi.fn((_p: unknown) => {
      // 返回 disposer
      return () => {}
    }),
    ask: vi.fn(),
  }
  const tools = {
    register: vi.fn((def: unknown) => {
      toolDefs.push(def)
      return () => {}
    }),
  }
  const ctx = {
    get: vi.fn((key: string) => {
      if (key === 'userQuestions') return userQuestions
      if (key === 'tools') return tools
      return undefined
    }),
    // 暴露供测试 inspect
    _toolDefs: toolDefs,
    _userQuestions: userQuestions,
    _tools: tools,
  }
  return ctx as unknown as Parameters<typeof registerAskUserTool>[0] & {
    _toolDefs: unknown[]
    _userQuestions: typeof userQuestions
    _tools: typeof tools
  }
}

describe('P-AskUserQuestion: registerAskUserProvider', () => {
  it('调 ctx.userQuestions.registerProvider,返回 disposer', () => {
    const ctx = makeFakeCtx()
    const sink = { ask: vi.fn() }
    const dispose = registerAskUserProvider(ctx, sink)
    expect(ctx._userQuestions.registerProvider).toHaveBeenCalledTimes(1)
    expect(ctx._userQuestions.registerProvider).toHaveBeenCalledWith(sink)
    expect(typeof dispose).toBe('function')
    // dispose 调用不抛错
    expect(() => dispose()).not.toThrow()
  })

  it('ctx.userQuestions 缺失时抛错(明示上游未装载 dsh-user-questions)', () => {
    const ctx = {
      get: vi.fn((k: string) => (k === 'tools' ? { register: () => () => {} } : undefined)),
    } as unknown as Parameters<typeof registerAskUserProvider>[0]
    expect(() => registerAskUserProvider(ctx, { ask: vi.fn() })).toThrow(/userQuestions service unavailable/)
  })
})

describe('P-AskUserQuestion: registerAskUserTool', () => {
  it('把 AskUserQuestion definition 注册到 ctx.tools', () => {
    const ctx = makeFakeCtx()
    const dispose = registerAskUserTool(ctx)
    expect(ctx._tools.register).toHaveBeenCalledTimes(1)
    expect(ctx._toolDefs).toHaveLength(1)
    const def = ctx._toolDefs[0] as { name: string }
    expect(def.name).toBe('AskUserQuestion')
    expect(typeof dispose).toBe('function')
  })

  it('ctx.tools 缺失时抛错(明示上游未装载 dsh-tools)', () => {
    const ctx = {
      get: vi.fn((k: string) => (k === 'userQuestions' ? { ask: vi.fn() } : undefined)),
    } as unknown as Parameters<typeof registerAskUserTool>[0]
    expect(() => registerAskUserTool(ctx)).toThrow(/tools service unavailable/)
  })

  it('ctx.userQuestions 缺失时也抛错(tool execute 闭包提前取 service)', () => {
    const ctx = {
      get: vi.fn((k: string) => (k === 'tools' ? { register: () => () => {} } : undefined)),
    } as unknown as Parameters<typeof registerAskUserTool>[0]
    expect(() => registerAskUserTool(ctx)).toThrow(/userQuestions service unavailable/)
  })
})

describe('P-AskUserQuestion: tool.execute 契约', () => {
  /**
   * 提取 tool.execute 并直接调它,绕过 dsh-tools register/dispatch 框架。
   */
  function getExecute(ctx: ReturnType<typeof makeFakeCtx>) {
    registerAskUserTool(ctx)
    const def = ctx._toolDefs[0] as { execute: (args: unknown, exec: unknown) => Promise<unknown> }
    return def.execute
  }

  it('空 questions 抛错(对齐 EMPTY_QUESTIONS 错误文案)', async () => {
    const ctx = makeFakeCtx()
    const execute = getExecute(ctx)
    await expect(
      execute(
        { questions: [] },
        { callId: { toString: () => 'c1' }, signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/at least one question/)
  })

  it('正常 input:给每题分配 stable id(q-{callId}-{i}),传给 userQuestions.ask', async () => {
    const ctx = makeFakeCtx()
    const execute = getExecute(ctx)
    // upstream 模拟返回:id=q-c1-0 选了 "opt1",id=q-c1-1 选了 "opt2"
    ctx._userQuestions.ask.mockResolvedValueOnce({
      answers: [
        { id: 'q-c1-0', selected: ['opt1'], custom: undefined },
        { id: 'q-c1-1', selected: ['opt2'], custom: undefined },
      ],
    })

    const result = (await execute(
      {
        questions: [
          {
            question: 'Q1 text',
            header: 'H1',
            options: [{ label: 'opt1', description: 'desc1' }],
          },
          {
            question: 'Q2 text',
            header: 'H2',
            options: [
              { label: 'opt2', description: 'desc2' },
              { label: 'opt3' },
            ],
            multiSelect: true,
          },
        ],
      },
      {
        callId: { toString: () => 'c1' },
        signal: new AbortController().signal,
      },
    )) as {
      answers: Array<{ question: string; header: string; selected: string[]; custom?: string }>
    }

    // 1. userQuestions.ask 被调一次,signal 透传,questions 含 stable id
    expect(ctx._userQuestions.ask).toHaveBeenCalledTimes(1)
    const askArg = ctx._userQuestions.ask.mock.calls[0]?.[0] as {
      questions: Array<{
        id: string
        question: string
        header?: string
        options?: unknown[]
        multiSelect?: boolean
      }>
      signal: AbortSignal
    }
    expect(askArg.questions).toHaveLength(2)
    expect(askArg.questions[0]?.id).toBe('q-c1-0')
    expect(askArg.questions[0]?.question).toBe('Q1 text')
    expect(askArg.questions[0]?.header).toBe('H1')
    expect(askArg.questions[1]?.id).toBe('q-c1-1')
    expect(askArg.questions[1]?.multiSelect).toBe(true)

    // 2. 答案按 id 还原成 question+header
    expect(result.answers).toEqual([
      { question: 'Q1 text', header: 'H1', selected: ['opt1'] },
      { question: 'Q2 text', header: 'H2', selected: ['opt2'] },
    ])
  })

  it('custom 字段透传(单选 Other 输入)', async () => {
    const ctx = makeFakeCtx()
    const execute = getExecute(ctx)
    ctx._userQuestions.ask.mockResolvedValueOnce({
      answers: [{ id: 'q-c1-0', selected: [], custom: 'user free-text answer' }],
    })
    const result = (await execute(
      {
        questions: [
          { question: 'Q', header: 'H', options: [{ label: 'A' }, { label: 'B' }] },
        ],
      },
      {
        callId: { toString: () => 'c1' },
        signal: new AbortController().signal,
      },
    )) as {
      answers: Array<{ question: string; header: string; selected: string[]; custom?: string }>
    }
    expect(result.answers[0]?.custom).toBe('user free-text answer')
    expect(result.answers[0]?.selected).toEqual([])
  })

  it('upstream answer 缺失某 id 时,selected 兜底空数组(不抛)', async () => {
    const ctx = makeFakeCtx()
    const execute = getExecute(ctx)
    // upstream 只回了第一题的答案,第二题没有
    ctx._userQuestions.ask.mockResolvedValueOnce({
      answers: [{ id: 'q-c1-0', selected: ['only1'], custom: undefined }],
    })
    const result = (await execute(
      {
        questions: [
          { question: 'Q1', header: 'H1', options: [{ label: 'only1' }] },
          { question: 'Q2', header: 'H2', options: [{ label: 'opt2' }] },
        ],
      },
      { callId: { toString: () => 'c1' }, signal: new AbortController().signal },
    )) as { answers: Array<{ selected: string[] }> }
    expect(result.answers[0]?.selected).toEqual(['only1'])
    expect(result.answers[1]?.selected).toEqual([])
  })

  it('空 header 时,工具结果 header 字段为空字符串(不抛)', async () => {
    const ctx = makeFakeCtx()
    const execute = getExecute(ctx)
    ctx._userQuestions.ask.mockResolvedValueOnce({
      answers: [{ id: 'q-c1-0', selected: ['a'], custom: undefined }],
    })
    const result = (await execute(
      { questions: [{ question: 'Q', header: '', options: [{ label: 'a' }] }] },
      { callId: { toString: () => 'c1' }, signal: new AbortController().signal },
    )) as { answers: Array<{ header: string }> }
    expect(result.answers[0]?.header).toBe('')
  })

  it('signal 从 exec 透传到 userQuestions.ask', async () => {
    const ctx = makeFakeCtx()
    const execute = getExecute(ctx)
    const ctrl = new AbortController()
    ctx._userQuestions.ask.mockResolvedValueOnce({
      answers: [{ id: 'q-c1-0', selected: ['a'], custom: undefined }],
    })
    await execute(
      { questions: [{ question: 'Q', header: 'H', options: [{ label: 'a' }] }] },
      { callId: { toString: () => 'c1' }, signal: ctrl.signal },
    )
    const askArg = ctx._userQuestions.ask.mock.calls[0]?.[0] as { signal: AbortSignal }
    expect(askArg.signal).toBe(ctrl.signal)
  })
})

/**
 * Schema 契约 - 给 LLM 看的 input contract 验证
 *
 * bug 背景: 原 askUser.ts 的 parameters schema 只有
 *   { questions: { type: 'array', required: true } }
 * 缺 items 描述,LLM 看不到 question/header/options/multiSelect 字段约束,
 * 经常发 [{question, header}] 但缺 options — 而 dsh-tools validate
 * 不深入校验 array elements(无 items 约束),"通过" 验证后到前端
 * QuestionCard 找不到 options,只渲染 "Other" radio。
 *
 * 修复: 加完整 items schema,questions[].options 强制 required。
 * 锁住工具 schema 经 dsh-tools 编译后:
 *   - questions.items 存在 + items.required 包含 [question, header, options]
 *   - items.properties.options.items.required 包含 ['label']
 *
 * 这是契约级 guard — 任何把 schema 改回"无 items"的尝试都会让这些
 * case 立即 fail,避免 bug 重现。
 *
 * 注意 dsh-tools DSL quirk:
 *   - `required` 不是顶层数组,而是标在每个 property spec 里(如
 *     `{type: 'string', required: true}`) — compile 时收进 property-map 的
 *     required 数组,最终以顶层 required 数组形式落到编译后 schema。
 *   - array spec 不允许顶层 `required`,只能通过 items 嵌套强制必填。
 *   - object items 内部也无 `required`,必须每个 property 标 `required: true`。
 */
describe('P-AskUserQuestion: tool input schema (LLM contract)', () => {
  /** 拿到 AskUserQuestion 工具经 dsh-tools 编译过的 parameters JSON schema。 */
  function getCompiledSchema(ctx: ReturnType<typeof makeFakeCtx>) {
    registerAskUserTool(ctx)
    const def = ctx._toolDefs[0] as { parameters: unknown }
    return def.parameters as {
      type: 'object'
      properties: { questions: JsonSchemaArray }
      required: string[]
    }
  }
  type JsonSchemaArray = { type: 'array'; items: JsonSchemaObject }
  type JsonSchemaObject = {
    type: 'object'
    additionalProperties?: boolean
    properties: Record<string, JsonSchemaNode>
    required?: string[]
  }
  type JsonSchemaNode =
    | { type: 'string' }
    | { type: 'boolean' }
    | { type: 'array'; items?: JsonSchemaObject | JsonSchemaNode }
    | JsonSchemaObject

  it('顶层 parameters schema 含 properties.questions + required=["questions"]', () => {
    const ctx = makeFakeCtx()
    const compiled = getCompiledSchema(ctx)
    expect(compiled.type).toBe('object')
    expect(compiled.required).toEqual(['questions'])
    expect(compiled.properties.questions?.type).toBe('array')
  })

  it('questions.items 是 object + items.required = [question, header, options]', () => {
    const ctx = makeFakeCtx()
    const compiled = getCompiledSchema(ctx)
    const items = compiled.properties.questions.items as JsonSchemaObject
    expect(items.type).toBe('object')
    expect(items.required).toEqual(['question', 'header', 'options'])
    expect(items.additionalProperties).toBe(false)
    expect(items.properties).toHaveProperty('question')
    expect(items.properties).toHaveProperty('header')
    expect(items.properties).toHaveProperty('options')
    expect(items.properties).toHaveProperty('multiSelect')
  })

  it('questions[].options 是 array + items 是 object + required=[label]', () => {
    const ctx = makeFakeCtx()
    const compiled = getCompiledSchema(ctx)
    const options = (compiled.properties.questions.items as JsonSchemaObject).properties
      .options as { type: 'array'; items: JsonSchemaObject }
    expect(options.type).toBe('array')
    expect(options.items.type).toBe('object')
    expect(options.items.required).toEqual(['label'])
    expect(options.items.additionalProperties).toBe(false)
    expect(options.items.properties).toHaveProperty('label')
    expect(options.items.properties).toHaveProperty('description')
  })

  it('REGRESSION (本 fix 加固): LLM 只发 question/header 不发 options → execute.args 触发 ToolArgsError,弹到工具层', async () => {
    // 直接调 tool.execute,让 dsh-tools validate 跑一遍。LLM args 只有
    // `{questions: [{question, header}]}` — 老 schema 会放行,新 schema
    // 必须拒绝。ToolArgsError 在 defineTool execute line 313-315 抛出。
    const ctx = makeFakeCtx()
    registerAskUserTool(ctx)
    const def = ctx._toolDefs[0] as {
      execute: (args: unknown, exec: unknown) => Promise<unknown>
    }
    await expect(
      def.execute(
        { questions: [{ question: 'Q', header: 'H' /* 缺 options */ }] },
        { callId: { toString: () => 'c1' }, signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/missing required property "questions\[0\]\.options"/)
  })

  it('REGRESSION: LLM 传 options 但每个 option 缺 label → execute 抛 ToolArgsError', async () => {
    const ctx = makeFakeCtx()
    registerAskUserTool(ctx)
    const def = ctx._toolDefs[0] as {
      execute: (args: unknown, exec: unknown) => Promise<unknown>
    }
    await expect(
      def.execute(
        {
          questions: [
            {
              question: 'Q',
              header: 'H',
              options: [{ description: 'no label' }], // 缺 label
            },
          ],
        },
        { callId: { toString: () => 'c1' }, signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/missing required property "questions\[0\]\.options\[0\]\.label"/)
  })

  it('PROPER: LLM 完整传 question/header/options[{label}] → execute 通过(到达 ctx.userQuestions.ask)', async () => {
    const ctx = makeFakeCtx()
    registerAskUserTool(ctx)
    const def = ctx._toolDefs[0] as {
      execute: (args: unknown, exec: unknown) => Promise<unknown>
    }
    ctx._userQuestions.ask.mockResolvedValueOnce({
      answers: [{ id: 'q-c1-0', selected: ['4'], custom: undefined }],
    })
    await expect(
      def.execute(
        {
          questions: [
            {
              question: '2+2=?',
              header: 'Math',
              options: [
                { label: '4' },
                { label: '3', description: '不是正确答案' },
              ],
            },
          ],
        },
        { callId: { toString: () => 'c1' }, signal: new AbortController().signal },
      ),
    ).resolves.toBeDefined()
    expect(ctx._userQuestions.ask).toHaveBeenCalledTimes(1)
  })

  it('工具 description 注明 "2-4 options" + 提示 UI 自动加 Other,提示 LLM 不要写 Other', () => {
    const ctx = makeFakeCtx()
    registerAskUserTool(ctx)
    const def = ctx._toolDefs[0] as { description: string }
    expect(def.description).toMatch(/2-4 options/i)
    expect(def.description).toMatch(/Other/i)
  })
})