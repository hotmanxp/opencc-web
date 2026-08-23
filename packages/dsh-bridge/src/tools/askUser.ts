/**
 * AskUserQuestion 模型可调工具 — P-AskUserQuestion。
 *
 * **背景**：上游 `@deepseek-ai/dsh-tool-ask-user` **未发布**(仅 service
 * definition 包 `@deepseek-ai/dsh-user-questions` 在 rc.8 落地)。zai dsh
 * 模式要让模型能调 AskUserQuestion,必须自实现 model-facing tool,走
 * dsh upstream `ctx.userQuestions` service seam:
 *
 *   1. **Provider 注册**(zai-side 注入):
 *      `registerAskUserProvider(ctx, sink)` 调
 *      `ctx.userQuestions.registerProvider({ask})`,把 zai askRegistry
 *      暴露为上游服务的 provider。
 *   2. **Model-facing tool 注册**:
 *      `registerAskUserTool(ctx)` 调 `ctx.tools.register(defineTool(...))`,
 *      模型可见工具名 `AskUserQuestion`(对齐 opencc vendor 命名)。
 *   3. tool.execute 内部走 `ctx.userQuestions.ask({questions, signal, agent})`,
 *      上游 service 路由到已注册的 provider(第 1 步)→ zai askRegistry。
 *
 * **字段对齐 dsh upstream 契约**(2026-08 探索发现):
 * - input 转 `AskUserQuestionItem[]`:每题加 `id`(zai-side 生成:`q-{callId}-{i}`)
 *   因为上游 `AskUserQuestionItem.id` 是 required,answers 用 id 回索引。
 * - signal 用 `exec.signal`(model-facing tool 自带 AbortSignal)。
 * - intent 字段不传:zai 不实现 plan-review intent(详情见
 *   `@deepseek-ai/dsh-user-questions` README.zh.md:27-29 — intent 只
 *   改变 UI 呈现,不改变协议)。
 * - 错误处理:zai sink 把 `UserQuestionError.ASK_ABORTED` 转成
 *   'aborted' reject;`EMPTY_QUESTIONS` 由上游 service 在 ask() 入口校验。
 *
 * **为什么不依赖 dsh-tool-ask-user 上游包**:`README.zh.md:33` 描述
 * `@deepseek-ai/dsh-tool-ask-user` 作为 Consumer 依赖本 service,但
 * `node_modules/.pnpm/@deepseek-ai+dsh-tool-ask-user*` 不存在(rc.8 阶段
 * 未发布)。未来发布后,zai-side 可保留本自实现作 fallback,或改为装载
 * 上游包(只需替换 registerAskUserTool 即可,provider 仍由 zai 注入)。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AskUserQuestionItem,
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionRequest,
  UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'

// Re-export 关键契约类型,让 zai-side factories 不需要把 dsh-user-questions 加
// 为直接依赖(同 index.ts 顶部 SessionId / Session 等 re-export 模式)。
export type {
  AskUserQuestionItem,
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionRequest,
  UserQuestionProvider,
}

/**
 * zai-side sink 契约 — 由 zai KernelAdapter(dsh) 在装载时注入。
 *
 * 内部实现应是:
 *   1. emit `prompt.ask` SSE(沿用 opencc 通道,dsh 模式复用)
 *   2. 等前端 QuestionCard 提交 `/api/agent/answer`
 *   3. 把 `Record<questionText, answerText>` 转回 `{answers: [{id,
 *      selected: [label], custom?}]}`(按 input items 的 id 索引回去)
 *
 * signal 触发 → reject `aborted` 错误(对齐 opencc AskRegistry.onAbort)。
 */
export type AskUserSink = UserQuestionProvider

/**
 * 在 dsh ctx 上注册 zai sink 为 userQuestions provider。
 *
 * 返回 disposer — 由 zai KernelAdapter 在 shutdown 链路上调用。
 * 失败时(`ctx.userQuestions` 未装载)抛错,显式提醒调用方未装载
 * `@deepseek-ai/dsh-user-questions`(检查 dsh-bridge.patch.yml)。
 */
export function registerAskUserProvider(ctx: Context, sink: AskUserSink): () => void {
  const userQuestions = ctx.get('userQuestions') as
    | { registerProvider: (p: UserQuestionProvider) => () => void }
    | undefined
  if (!userQuestions) {
    throw new Error(
      '[dsh-bridge] askUser: userQuestions service unavailable — was @deepseek-ai/dsh-user-questions loaded?',
    )
  }
  return userQuestions.registerProvider(sink)
}

/** dsh-tools 参数 schema(对齐 opencc vendor AskUserQuestionTool)。 */
export interface AskUserToolInput {
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
}

/** 工具输出 — 把 dsh upstream AskUserQuestionAnswer 翻译为可读 question+header 形态。 */
export interface AskUserToolResult {
  answers: Array<{
    question: string
    header: string
    selected: string[]
    custom?: string
  }>
}

/**
 * 工具输出 renderer — 把 answers 序列化成可读文本。
 * 与 opencc vendor 一致:每题一行 `[header] question → answer`。
 */
function renderResult(value: AskUserToolResult): string {
  const lines: string[] = []
  for (const a of value.answers) {
    const ans = a.custom
      ? `Other: ${a.custom}`
      : a.selected.length === 1
        ? a.selected[0]
        : a.selected.length > 1
          ? `Multi-select: ${a.selected.join(', ')}`
          : '(skipped)'
    lines.push(`[${a.header}] ${a.question} → ${ans}`)
  }
  return lines.join('\n')
}

/**
 * 创建 AskUserQuestion 工具实例。
 *
 * execute 内部走 `ctx.userQuestions.ask`(**必须是闭包 ctx,不是
 * `exec`** — exec 是 ToolRunContext,不含 service),由上游 service 路由
 * 到 provider(registerAskUserProvider 注入的 zai sink)。
 *
 * 注意 `defineTool` 顶层不能拿 ctx — 我们用工厂模式(createAskUserTool
 * 接收 ctx,closure 捕获)。
 */
export function createAskUserTool(ctx: Context) {
  // 提前取 userQuestions(避免每次 execute 都 ctx.get)。
  // 若 service 缺失抛错 — 提示调用方检查 dsh-bridge.patch.yml 是否装载。
  const userQuestions = ctx.get('userQuestions') as
    | {
        ask: (req: {
          questions: AskUserQuestionItem[]
          signal?: AbortSignal
          agent?: unknown
        }) => Promise<AskUserQuestionAnswer>
      }
    | undefined
  if (!userQuestions) {
    throw new Error(
      '[dsh-bridge] askUser: userQuestions service unavailable — was @deepseek-ai/dsh-user-questions loaded?',
    )
  }

  return defineTool({
    name: 'AskUserQuestion',
    description:
      'Use this tool when you need to ask the user clarifying questions ' +
      'before proceeding with a task. Each question should have 2-4 ' +
      'options. The UI will automatically add an "Other" option for ' +
      'free-text input. Do not include an "Other" option yourself.',
    parameters: {
      questions: {
        type: 'array',
        description: 'Questions to present to the user.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          answers: {
            type: 'array',
            description: 'Answers indexed back by question (header + selected/custom).',
          },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        const v = value as AskUserToolResult
        return [{ type: 'text', text: renderResult(v) }]
      },
    },
    /**
     * 10 分钟 — 上限对齐 opencc vendor AskUserQuestionTool 默认 timeout。
     * 用户在前端可以无限等;真超时由 abort signal 触发。
     */
    timeoutMs: 600_000,
    async execute(args, exec) {
      const a = args as AskUserToolInput
      if (!Array.isArray(a.questions) || a.questions.length === 0) {
        // 与上游 UserQuestionError('ask_user_question requires at least one
        // question', 'EMPTY_QUESTIONS') 文案对齐。
        throw new Error('ask_user_question requires at least one question')
      }

      // 1. 给每题分配 stable id(caller-provided,echoed in answer)
      const callIdStr = exec.callId.toString()
      const items: AskUserQuestionItem[] = a.questions.map((q, i) => {
        const item: AskUserQuestionItem = {
          id: `q-${callIdStr}-${i}`,
          question: q.question,
        }
        if (q.header) item.header = q.header
        if (q.options && q.options.length > 0) {
          item.options = q.options.map((o) => {
            const opt: { label: string; description?: string } = { label: o.label }
            if (o.description !== undefined) opt.description = o.description
            return opt
          })
        }
        if (q.multiSelect !== undefined) item.multiSelect = q.multiSelect
        return item
      })

      // 2. 走 dsh upstream seam → provider(zai sink) → askRegistry
      const upstream = await userQuestions.ask({
        questions: items,
        signal: exec.signal,
        agent: exec.agent,
      })

      // 3. 把 dsh answer.items 用 id 还原为 question+header 形态
      const answerItems: AskUserQuestionAnswerItem[] = upstream.answers ?? []
      const byId = new Map<string, AskUserQuestionAnswerItem>()
      for (const ai of answerItems) byId.set(ai.id, ai)

      const answers: AskUserToolResult['answers'] = items.map((item) => {
        const ai = byId.get(item.id)
        const result: {
          question: string
          header: string
          selected: string[]
          custom?: string
        } = {
          question: item.question,
          header: item.header ?? '',
          selected: ai?.selected ?? [],
        }
        if (ai?.custom !== undefined) result.custom = ai.custom
        return result
      })

      return { answers }
    },
  })
}

/**
 * 注册 AskUserQuestion 工具到 dsh ctx。
 *
 * **注册顺序要求**:必须在 `registerAskUserProvider(ctx, sink)` **之后**
 * 调用 — tool.execute 内部走 ctx.userQuestions.ask,依赖已注册的 provider
 * (否则上游抛 UserQuestionError('NO_PROVIDER'))。
 *
 * 返回 disposer — 由 zai KernelAdapter 在 shutdown 链路上调用。
 */
export function registerAskUserTool(ctx: Context): () => void {
  const tools = ctx.get('tools') as { register: (definition: unknown) => () => void } | undefined
  if (!tools) {
    throw new Error(
      '[dsh-bridge] askUser: tools service unavailable — was @deepseek-ai/dsh-tools loaded?',
    )
  }
  const tool = createAskUserTool(ctx)
  return tools.register(tool) as () => void
}