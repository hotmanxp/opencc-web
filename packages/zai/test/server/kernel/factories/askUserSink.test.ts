/**
 * createAskUserSink 单元测试 — P-AskUserQuestion。
 *
 * 验证 zai 侧 sink 的字段翻译契约:
 *   1. dsh upstream questions 转 zai prompt.ask SSE 形态
 *      (`{question, header, options, multiSelect?}`,id 字段不发)。
 *   2. toolUseId 通过 generateToolUseId 工厂生成(默认 `q-` 前缀)。
 *   3. askRegistry.register 用生成的 toolUseId + 当前 sessionId 调用。
 *   4. signal 透传到 askRegistry.register(若上游有 abort signal)。
 *   5. askRegistry.resolve 出的 payload 形状对齐 `routes/answer.ts:7-14` zod schema:
 *      `{answers: Record<questionText, answerText>, annotations?: {...}}`。
 *      sink 必须先剥 `payload.answers` 再按 questionText 索引,否则
 *      `answersRecord[item.question]` 拿到 undefined,selected 退化为 [],
 *      dsh-side `askUser.renderResult` 输出 `(skipped)`,AI 把这次提交
 *      误判为"用户跳过了问题"——见 regression 用例。
 *   6. 向后兼容: 旧 schema(整个对象顶层就是 flat map)→ 走 fallback 当 flat map 处理。
 *   7. eventBus 未注入时 warn 不抛错,正常完成翻译(便于单测)。
 *
 * 不依赖 dsh 真实 runtime — 用 fake askRegistry + fake eventBus。
 */
import { describe, it, expect, vi } from 'vitest'
import { createAskUserSink } from '../../../../src/server/services/kernel/factories/askUserSink.js'
import type { AskUserQuestionItem } from '@zn-ai/dsh-bridge'

/**
 * askRegistry.resolve 给出的真实 payload 形状 — 来自
 * `routes/answer.ts:7-14` 的 zod schema 与 `routes/answer.ts:50-53` 的
 * `registry.answer(toolUseId, payload)` 调用:
 *   `{answers: Record<questionText, answerText>, annotations?: ...}`。
 *
 * 旧实现曾 mock 整个对象顶层就是 flat map(`{'Q1 text': 'opt1'}`),
 * 这与生产不符 —— 漏掉 `answers.` 前缀曾经让所有 dsh-mode 答复被
 * 误判为 skipped。本测试默认走真实形状,旧扁平 map 形状作为
 * fallback 兼容 case 单测。
 */
type AskRegistryAnswer =
  | { answers: Record<string, unknown>; annotations?: Record<string, unknown> }
  | Record<string, unknown>

describe('P-AskUserQuestion: createAskUserSink', () => {
  function makeDeps(
    overrides: Partial<{
      getSessionId: () => string | undefined
      askRegistryAnswer: AskRegistryAnswer
    }> = {},
  ) {
    const sessionId = overrides.getSessionId?.() ?? 'sess-test'
    const askRegistry = {
      register: vi.fn(
        async (_toolUseId: string, _sid: string, _signal: AbortSignal) =>
          overrides.askRegistryAnswer ?? {},
      ),
    }
    const eventBus = { emit: vi.fn() }
    return {
      getSessionId: overrides.getSessionId ?? (() => sessionId),
      askRegistry,
      eventBus,
    }
  }

  it('emit prompt.ask SSE,questions 字段对齐 zai QuestionCard 期望(不含 id)', async () => {
    const deps = makeDeps({
      askRegistryAnswer: { answers: { 'Q1 text': 'opt1' } },
    })
    const sink = createAskUserSink({
      getSessionId: deps.getSessionId,
      askRegistry: deps.askRegistry,
      eventBus: deps.eventBus,
      generateToolUseId: () => 'q-fixed',
    })

    await sink.ask({
      questions: [
        {
          id: 'q-fixed-0',
          question: 'Q1 text',
          header: 'H1',
          options: [{ label: 'opt1', description: 'desc1' }],
          multiSelect: false,
        } as AskUserQuestionItem,
      ],
      signal: new AbortController().signal,
    })

    expect(deps.eventBus.emit).toHaveBeenCalledTimes(1)
    const emitted = deps.eventBus.emit.mock.calls[0]?.[0] as {
      type: string
      sessionId: string
      toolUseId: string
      questions: Array<Record<string, unknown>>
    }
    expect(emitted.type).toBe('prompt.ask')
    expect(emitted.sessionId).toBe('sess-test')
    expect(emitted.toolUseId).toBe('q-fixed')
    // id 字段被剥除,只发给前端它能消费的字段
    expect(emitted.questions[0]).toEqual({
      question: 'Q1 text',
      header: 'H1',
      options: [{ label: 'opt1', description: 'desc1' }],
      multiSelect: false,
    })
  })

  it('header 缺失时用空字符串兜底,options 缺失时用空数组兜底,multiSelect 不在 input 时字段被 omitted', async () => {
    const deps = makeDeps()
    const sink = createAskUserSink({
      getSessionId: deps.getSessionId,
      askRegistry: deps.askRegistry,
      eventBus: deps.eventBus,
      generateToolUseId: () => 'q-fixed',
    })
    await sink.ask({
      // 不传 header / options / multiSelect(让 dsh 上游这些字段都是 undefined)
      questions: [
        { id: 'q-fixed-0', question: 'Q' } as unknown as AskUserQuestionItem,
      ],
      signal: new AbortController().signal,
    })
    const emitted = deps.eventBus.emit.mock.calls[0]?.[0] as {
      questions: Array<Record<string, unknown>>
    }
    // header: '' (兜底),options: [] (兜底),multiSelect 字段被 omitted
    expect(emitted.questions[0]).toEqual({ question: 'Q', header: '', options: [] })
  })

  it('askRegistry.register 用生成 toolUseId + 当前 sessionId + 透传 signal', async () => {
    const deps = makeDeps()
    const ctrl = new AbortController()
    const sink = createAskUserSink({
      getSessionId: () => 'sess-A',
      askRegistry: deps.askRegistry,
      eventBus: deps.eventBus,
      generateToolUseId: () => 'q-ABC',
    })
    await sink.ask({
      questions: [
        { id: 'q-ABC-0', question: 'Q', header: 'H', options: [] } as AskUserQuestionItem,
      ],
      signal: ctrl.signal,
    })
    expect(deps.askRegistry.register).toHaveBeenCalledTimes(1)
    expect(deps.askRegistry.register).toHaveBeenCalledWith('q-ABC', 'sess-A', ctrl.signal)
  })

  it('getSessionId 返回 undefined 时,askRegistry 收到空 sessionId', async () => {
    const deps = makeDeps()
    const sink = createAskUserSink({
      getSessionId: () => undefined,
      askRegistry: deps.askRegistry,
      eventBus: deps.eventBus,
      generateToolUseId: () => 'q-ABC',
    })
    await sink.ask({
      questions: [
        { id: 'q-ABC-0', question: 'Q', header: 'H', options: [] } as AskUserQuestionItem,
      ],
      signal: new AbortController().signal,
    })
    expect(deps.askRegistry.register).toHaveBeenCalledWith(
      'q-ABC',
      '',
      expect.any(AbortSignal),
    )
  })

  it('默认 generateToolUseId 用 `q-` 前缀', async () => {
    const deps = makeDeps()
    const sink = createAskUserSink({
      getSessionId: deps.getSessionId,
      askRegistry: deps.askRegistry,
      eventBus: deps.eventBus,
      // 不传 generateToolUseId → 走默认实现
    })
    await sink.ask({
      questions: [
        { id: 'q-0', question: 'Q', header: 'H', options: [] } as AskUserQuestionItem,
      ],
      signal: new AbortController().signal,
    })
    const emitted = deps.eventBus.emit.mock.calls[0]?.[0] as { toolUseId: string }
    expect(emitted.toolUseId).toMatch(/^q-[a-z0-9]+-[a-z0-9]+$/)
  })

  it('askRegistry 返回 routes/answer.ts 真实 payload 形状 {answers:{...}} → 解包后按 questionText 索引', async () => {
    const deps = makeDeps({
      askRegistryAnswer: {
        answers: {
          'Q1 text': 'opt1',
          'Q2 text': 'optA, optB',
        },
      },
    })
    const sink = createAskUserSink({
      getSessionId: deps.getSessionId,
      askRegistry: deps.askRegistry,
      eventBus: deps.eventBus,
      generateToolUseId: () => 'q-fixed',
    })

    const result = await sink.ask({
      questions: [
        { id: 'q-fixed-0', question: 'Q1 text', header: 'H1', options: [] } as AskUserQuestionItem,
        { id: 'q-fixed-1', question: 'Q2 text', header: 'H2', options: [] } as AskUserQuestionItem,
      ],
      signal: new AbortController().signal,
    })

    expect(result.answers).toEqual([
      { id: 'q-fixed-0', selected: ['opt1'] },
      { id: 'q-fixed-1', selected: ['optA, optB'] },
    ])
  })

  it('REGRESSION: 顶层 flat map(老 schema fallback)→ 仍按 questionText 索引', async () => {
    // 兜底兼容: 早期某些内部调用可能直接发 flat map(没有 .answers 包装层)。
    // 解包公式 `(raw.answers ?? raw)` 保证这种情况下也能找回答案。
    const deps = makeDeps({
      askRegistryAnswer: {
        'Q1 text': 'opt1',
        'Q2 text': 'opt2',
      } as unknown as AskRegistryAnswer,
    })
    const sink = createAskUserSink({
      getSessionId: deps.getSessionId,
      askRegistry: deps.askRegistry,
      eventBus: deps.eventBus,
      generateToolUseId: () => 'q-fixed',
    })
    const result = await sink.ask({
      questions: [
        { id: 'q-fixed-0', question: 'Q1 text', header: 'H', options: [] } as AskUserQuestionItem,
        { id: 'q-fixed-1', question: 'Q2 text', header: 'H', options: [] } as AskUserQuestionItem,
      ],
      signal: new AbortController().signal,
    })
    expect(result.answers).toEqual([
      { id: 'q-fixed-0', selected: ['opt1'] },
      { id: 'q-fixed-1', selected: ['opt2'] },
    ])
  })

  it('payload.answers 里某题缺失 → 该题 selected 兜底空数组 (renderResult 走 skipped 路径)', async () => {
    const deps = makeDeps({
      askRegistryAnswer: { answers: { 'Q1 text': 'opt1' } },
    })
    const sink = createAskUserSink({
      getSessionId: deps.getSessionId,
      askRegistry: deps.askRegistry,
      eventBus: deps.eventBus,
      generateToolUseId: () => 'q-fixed',
    })
    const result = await sink.ask({
      questions: [
        { id: 'q-fixed-0', question: 'Q1 text', header: 'H', options: [] } as AskUserQuestionItem,
        { id: 'q-fixed-1', question: 'Q2 text', header: 'H', options: [] } as AskUserQuestionItem,
      ],
      signal: new AbortController().signal,
    })
    expect(result.answers).toEqual([
      { id: 'q-fixed-0', selected: ['opt1'] },
      { id: 'q-fixed-1', selected: [] },
    ])
  })

  it('payload.answers value 不是字符串(数字/null)→ 当作空字符串兜底(整题 selected=[])', async () => {
    const deps = makeDeps({
      askRegistryAnswer: { answers: { Q1: 42, Q2: null } },
    })
    const sink = createAskUserSink({
      getSessionId: deps.getSessionId,
      askRegistry: deps.askRegistry,
      eventBus: deps.eventBus,
      generateToolUseId: () => 'q-fixed',
    })
    const result = await sink.ask({
      questions: [
        { id: 'q-fixed-0', question: 'Q1', header: 'H', options: [] } as AskUserQuestionItem,
        { id: 'q-fixed-1', question: 'Q2', header: 'H', options: [] } as AskUserQuestionItem,
      ],
      signal: new AbortController().signal,
    })
    expect(result.answers[0]?.selected).toEqual([])
    expect(result.answers[1]?.selected).toEqual([])
  })

  it('eventBus 未注入时 warn 不抛错,正常返回答案', async () => {
    const deps = makeDeps({
      askRegistryAnswer: { answers: { Q1: 'a' } },
    })
    const sink = createAskUserSink({
      getSessionId: deps.getSessionId,
      askRegistry: deps.askRegistry,
      // eventBus 不传
      generateToolUseId: () => 'q-fixed',
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await sink.ask({
      questions: [
        { id: 'q-fixed-0', question: 'Q1', header: 'H', options: [] } as AskUserQuestionItem,
      ],
      signal: new AbortController().signal,
    })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('eventBus 未注入'))
    expect(result.answers).toEqual([{ id: 'q-fixed-0', selected: ['a'] }])
    warnSpy.mockRestore()
  })

  it('REGRESSION (核心 bug): askRegistry 返回真实 {answers:{...}} 包装 → 每题 selected 都拿到值(不是 [] 跳过)', async () => {
    // 这是用户报告的"AI 收到问题已显示但你跳过了选择"的直接回归。
    // 旧实现把 `{answers: {q1: a1}}` 当 flat map 取 → answersRecord[item.question]
    // = undefined → selected=[] → renderResult → "(skipped)"。
    // 正确实现必须先剥 `.answers`,再按 questionText 索引。
    const deps = makeDeps({
      askRegistryAnswer: {
        answers: { '请选择颜色': '蓝色' },
        annotations: { '请选择颜色': {} },
      },
    })
    const sink = createAskUserSink({
      getSessionId: deps.getSessionId,
      askRegistry: deps.askRegistry,
      eventBus: deps.eventBus,
      generateToolUseId: () => 'q-fixed',
    })
    const result = await sink.ask({
      questions: [
        {
          id: 'q-fixed-0',
          question: '请选择颜色',
          header: '颜色',
          options: [{ label: '蓝色' }, { label: '红色' }],
        } as AskUserQuestionItem,
      ],
      signal: new AbortController().signal,
    })
    // 关键 assertion: 不应该是 [], 应该是 ['蓝色']
    expect(result.answers).toEqual([{ id: 'q-fixed-0', selected: ['蓝色'] }])
  })
})