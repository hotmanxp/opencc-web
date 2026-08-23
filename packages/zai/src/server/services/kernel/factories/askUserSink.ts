/**
 * AskUserQuestion sink — P-AskUserQuestion。
 *
 * 把 dsh upstream `ctx.userQuestions.ask()` 的 provider 桥接到 zai 的
 * `askRegistry` + `eventBus.emit('prompt.ask')`。
 *
 * 链路:
 *   1. dsh-side tool.execute 调 ctx.userQuestions.ask({questions, signal, agent})
 *   2. 上游 service 路由到 zai-side `registerAskUserProvider(ctx, sink)` 注册的 provider
 *   3. provider(本模块导出)emit `prompt.ask` SSE → 前端 QuestionCard 渲染
 *   4. zai askRegistry.register(toolUseId, sessionId, signal) 等用户答复
 *   5. 用户提交后,前端 /api/agent/answer → askRegistry.answer(payload) → Promise resolve
 *      payload 形状 = `{answers: Record<questionText, answerText>, annotations?: {...}}`
 *      (对齐 `routes/answer.ts` 的 zod schema)
 *   6. 剥 `payload.answers` 后按 questionText 索引 → dsh upstream 契约
 *      `{answers: [{id, selected: [label]}]}`,每题用 dsh-side `q-{callId}-{i}` id 回索引
 *
 * **为什么不直接 import `__zaiEventBus` 与 `getAskRegistry`****:**
   工厂模式注入,让本模块可以独立 typecheck + 单测。dsh.ts 在 createSession
   时把已初始化的 eventBus / askRegistry / sessionId getter 传进来。
 *
 * **payload 解包与 opencc-mode 同步**: opencc-mode askUserQuestionCall
 * (`compat/tools/index.ts:344-351`) 早已写了 `(raw.answers ?? raw)` 兼容
 * 解包。dsh-mode 早期实现漏了这步,直接当 flat map 取 — 后果: `answersRecord[item.question]`
 * 永远是 undefined,selected 退化为空数组,工具结果输出 `(skipped)`,AI
 * 把这次提交误判为"用户跳过了问题"。修这里解包后,双轨走的同一个解包公式。
 */

import type {
  AskUserSink,
  AskUserQuestionItem,
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionRequest,
  UserQuestionProvider,
} from '@zn-ai/dsh-bridge'

/**
 * `routes/answer.ts:7-14` zod schema 决定 askRegistry.resolve 的 payload 形状:
 *   `{answers: Record<questionText, answerText>, annotations?: Record<questionText, {preview?, notes?}>}`
 * (zai src/shared 里 AskUserAnswers 类型 alias 是 `Record<string, unknown>`,
 * 但实际值是上面这个嵌套形式 — 与 opencc-mode 同形)
 */

export interface CreateAskUserSinkOptions {
  /** 读当前 sessionId — 用于 prompt.ask SSE 与 askRegistry 路由。 */
  getSessionId: () => string | undefined
  /** 调 zai askRegistry.register(toolUseId, sessionId, signal)。 */
  askRegistry: {
    register: (toolUseId: string, sessionId: string, abortSignal: AbortSignal) => Promise<unknown>
  }
  /** emit `prompt.ask` SSE;若没初始化(单测场景),warn 但不抛错。 */
  eventBus?: { emit: (e: unknown) => void }
  /**
   * 生成 toolUseId 的工厂 — 默认 `q-{base36 timestamp}-{random suffix}`。
   * 测试可注入确定性 generator 验证唯一性/前缀。
   */
  generateToolUseId?: () => string
}

const DEFAULT_ID_PREFIX = 'q-'
function defaultGenerateToolUseId(): string {
  return `${DEFAULT_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 创建 dsh userQuestions provider,桥接到 zai askRegistry。
 *
 * 返回的 sink 用作 `registerAskUserProvider(ctx, sink)` 的第二参。
 * 同一 process 可多次调用本工厂创建多 sink(provider 重复注册会抛
 * `DUPLICATE_PROVIDER`,由调用方保证单例)。
 */
export function createAskUserSink(opts: CreateAskUserSinkOptions): AskUserSink {
  const {
    getSessionId,
    askRegistry,
    eventBus,
    generateToolUseId = defaultGenerateToolUseId,
  } = opts
  const provider: UserQuestionProvider = {
    async ask(req: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
      const sessionId = getSessionId() ?? ''
      const toolUseId = generateToolUseId()

      // 1. emit `prompt.ask` SSE → 前端 QuestionCard 渲染
      //    questions 字段对齐 zai QuestionCard 期望:`{question, header, options, multiSelect}`
      //    dsh upstream 的 `id` 字段不发给前端(前端按 questionText 索引 answers);
      //    sink 内部按 questionText 索引回 id。
      if (eventBus) {
        eventBus.emit({
          type: 'prompt.ask',
          sessionId,
          toolUseId,
          questions: req.questions.map((q: AskUserQuestionItem) => ({
            question: q.question,
            header: q.header ?? '',
            options: q.options ?? [],
            ...(q.multiSelect !== undefined ? { multiSelect: q.multiSelect } : {}),
          })),
        })
      } else {
        console.warn('[askUserSink] eventBus 未注入,前端可能看不到 QuestionCard')
      }

      // 2. 等用户答复。zai askRegistry(由 routes/answer.ts:50-53 经
      //    registry.answer(toolUseId, payload) 写入)resolve 的 payload
      //    形状是 `{answers: Record<questionText, answerText>, annotations?: ...}`
      //    — 与 opencc-mode askUserQuestionCall(compat/tools/index.ts:344-351)
      //    收到的同形,所以两边都要先剥 `raw.answers`,再 fallback 到 raw 本体
      //    (兼容直接发 flat map 的旧 schema)。
      //
      //    **关键**: dsh-mode 早期实现漏了这个解包 — 把整个 payload
      //    当 flat map 取, `answersRecord[item.question]` 永远拿到
      //    undefined (对象顶层键是 `answers` 而非 question text),
      //    selected 退化为空数组, renderResult 输出 `(skipped)` —
      //    AI 看到 "问题已显示但你跳过了选择"。
      const abortSignal = req.signal ?? new AbortController().signal
      const raw =
        ((await askRegistry.register(toolUseId, sessionId, abortSignal)) as
          | Record<string, unknown>
          | null) ?? {}

      // 3. 转回 dsh upstream 契约 `{answers: [{id, selected: [label]}]}`
      const answersRecord =
        (raw.answers as Record<string, unknown> | undefined) ?? raw
      const answers: AskUserQuestionAnswerItem[] = req.questions.map(
        (item: AskUserQuestionItem): AskUserQuestionAnswerItem => {
          const val = answersRecord[item.question]
          const text = typeof val === 'string' && val.length > 0 ? val : ''
          const selected: string[] = text ? [text] : []
          return {
            id: item.id,
            selected,
          }
        },
      )
      return { answers }
    },
  }
  return provider
}