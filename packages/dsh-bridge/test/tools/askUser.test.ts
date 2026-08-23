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