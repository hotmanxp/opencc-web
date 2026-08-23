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
 *   5. 用户提交后,前端 /api/agent/answer → askRegistry.answer → Promise resolve
 *   6. 把 `Record<questionText, answerText>` 转回 dsh upstream 契约
 *      `{answers: [{id, selected: [label], custom?}]}`,按 questionText 索引
 *
 * **为什么不直接 import `__zaiEventBus` 与 `getAskRegistry`****:**
   工厂模式注入,让本模块可以独立 typecheck + 单测。dsh.ts 在 createSession
   时把已初始化的 eventBus / askRegistry / sessionId getter 传进来。
 */

import type {
  AskUserSink,
  AskUserQuestionItem,
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionRequest,
} from '@zn-ai/dsh-bridge'

/** zai askRegistry.register 返回的 `AskUserAnswers = Record<string, unknown>`。 */
type ZaiAskUserAnswers = Record<string, unknown>

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
  return async (req: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
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

    // 2. 等用户答复。zai askRegistry 返回 `Record<questionText, answerText>`。
    const abortSignal = req.signal ?? new AbortController().signal
    const zaiAnswers = (await askRegistry.register(toolUseId, sessionId, abortSignal)) ?? {}

    // 3. 转回 dsh upstream 契约 `{answers: [{id, selected: [label]}]}`
    const answersRecord = zaiAnswers as ZaiAskUserAnswers
    const answers: AskUserQuestionAnswerItem[] = req.questions.map(
      (item: AskUserQuestionItem) => {
        const raw = answersRecord[item.question]
        const text = typeof raw === 'string' && raw.length > 0 ? raw : ''
        return {
          id: item.id,
          selected: text ? [text] : [],
        }
      },
    )
    return { answers }
  }
}