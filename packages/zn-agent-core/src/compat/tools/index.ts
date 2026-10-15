// @zn-ai/zn-agent-core compat shim — zai-native tool executors.
//
// Only AskUserQuestion survives here: it is wrapped by
// `compat/tools/opencc/AskUserQuestionTool.ts` into the opencc tool pool
// (wired at `opencc-src/server/createHeadlessContext-impl.ts:290`), so the
// zai-native executor is the live implementation behind the model's
// `AskUserQuestion` tool.
//
// Bash / FileRead / FileWrite / FileEdit / Skill are NOT here — the model
// gets vendor's own implementations via `opencc-src/tools.ts` `getTools()`.
// `buildDefaultTools()` was the old registry; it had no production caller.
//
// Schemas are zod; modelCaller converts to JSON Schema before sending to
// the Anthropic SDK (see modelCaller.ts::buildAnthropicInputSchema).

import { z } from 'zod'
import type { ToolCallCtx } from '../runtime/modelCaller.js'
import { makeTool } from './makeTool.js'
export { makeTool }

// --- Schemas ---------------------------------------------------------------

// AskUserQuestion 走 opencc 原生 schema: questions 是 array (1-4 个),
// metadata.source 标识来源. 这是模型按训练格式会发的形状, 不要
// 简化成单数 question: string, 否则 zod safeParse 失败, makeTool
// 走 "[error] invalid input for AskUserQuestion" 兜底, QuestionCard
// 永远不弹. 见 opencc-src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx:64-69
const AskUserOptionSchema = z.object({
  label: z.string().describe('The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.'),
  description: z.string().optional().describe('Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.'),
  preview: z.string().optional().describe('Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons.'),
})
const AskUserQuestionItemSchema = z.object({
  question: z.string().describe('The complete question to ask the user. Should be clear, specific, and end with a question mark.'),
  header: z.string().max(32).describe('Very short label displayed as a chip/tag (max 32 chars). Examples: "Auth method", "Library", "Approach".'),
  options: z.array(AskUserOptionSchema).min(2).max(4).describe('The available choices for this question. Must have 2-4 options. Each option must be a distinct, mutually exclusive choice. There should be no "Other" option — that is provided automatically.'),
  multiSelect: z.boolean().optional().describe('Set to true to allow the user to select multiple options instead of just one.'),
})
const AskUserQuestionInput = z.object({
  questions: z.array(AskUserQuestionItemSchema).min(1).max(4).describe('Questions to ask the user (1-4 questions).'),
  metadata: z
    .object({
      source: z.string().optional().describe('Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.'),
    })
    .optional()
    .describe('Optional metadata for tracking and analytics purposes. Not displayed to user.'),
})

// --- AskUserQuestion --------------------------------------------------------

/**
 * 把 AskUserQuestion 的答复格式化成给模型的 tool_result 字符串。
 *
 * **必须与 vendor `AskUserQuestionTool.tsx` 的
 * `mapToolResultToToolResultBlockParam` 逐字对齐** —— 模型是按那个契约
 * 训练的:它靠 `User has answered your questions: "q"="a". ...` 这层框架
 * 判定"用户确实答了这题"。
 *
 * zai shim 早期自造的是裸行 `q? -> a`:没有框架,问题文本本身以 `?` 结尾
 * 时还会打出 `??`。自由文本答案(Other / 自定义输入)不在 options 里,
 * 配上这行残缺文本,模型会读成"格式坏掉 / 工具拒收了这个答案",于是回头
 * 告诉用户「工具只接受预设选项,不能自由输入」—— 用户实际看到的就成了
 * "工具调用错误"。改用 vendor 格式后,自由文本同样是合法的 `"q"="a"`。
 *
 * answer 值可能是 string (单选), array (多选, opencc 用 `, ` 拼),
 * 或任意 JSON。
 */
function formatAskAnswer(
  input: z.infer<typeof AskUserQuestionInput>,
  answers: Record<string, unknown>,
): string {
  const render = (raw: unknown): string => {
    if (typeof raw === 'string') return raw
    if (Array.isArray(raw)) return raw.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ')
    if (raw == null) return '(no answer)'
    return JSON.stringify(raw)
  }
  const parts: string[] = []
  for (const q of input.questions) {
    parts.push(`"${q.question}"="${render(answers[q.question])}"`)
  }
  const answersText = parts.length > 0 ? parts.join(', ') : JSON.stringify(answers)
  return `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`
}

async function askUserQuestionCall(
  input: z.infer<typeof AskUserQuestionInput>,
  ctx: ToolCallCtx,
): Promise<{ output: string }> {
  // 没接 askRegistry (单测/无 server 注入) → 走 stub, 保持向后兼容.
  if (!ctx.askRegistry || !ctx.onYield || !ctx.toolUseId || !ctx.sessionId) {
    const allOpts = input.questions
      .flatMap((q, qi) =>
        (q.options ?? []).map((o, oi) => `  Q${qi + 1}.${oi + 1} ${o.label}${o.description ? ` — ${o.description}` : ''}`),
      )
      .join('\n')
    return {
      output:
        `[zai askRegistry not configured] Asked ${input.questions.length} question(s)\n` +
        input.questions.map((q) => `  - ${q.question}`).join('\n') +
        (allOpts ? `\nOptions:\n${allOpts}\n` : '') +
        `(opencc query bridge did not pass askRegistry / onYield / toolUseId / sessionId — no user answer was captured.)`,
    }
  }
  // 关键: 必须先 yield tool_use:ask_pending, 再 await askRegistry.
  // 顺序保证: translateRuntimeEvents 看到 ask_pending 时会立刻转 SSE
  // `prompt.ask` 推给前端, QuestionCard 渲染; 同时 askRegistry.register
  // 的 Promise 在这里挂起, 等前端 POST /api/agent/answer 触发 resolve.
  //
  // questions 字段直接是 input.questions 数组 (opencc schema 1-4 个).
  // metadata 透传模型的 metadata, 没传时塞一个 source:'AskUserQuestion'
  // 标识 (前端 transcript resync 路径可区分 ask 与 approve).
  const onYieldMetadata = input.metadata ?? { source: 'AskUserQuestion' }
  ctx.onYield({
    type: 'tool_use:ask_pending',
    id: ctx.toolUseId,
    toolUseId: ctx.toolUseId,
    questions: input.questions,
    metadata: onYieldMetadata,
  })
  // 用一个只在本次 query 内活跃的 AbortSignal — opts.abortSignal 已经覆盖
  // 整个 query 的 abort 路径, 借用即可, 不必自己再包一层。
  const signal = ctx.abortSignal ?? new AbortController().signal
  try {
    // askRegistry.answer resolve 出的 payload 形状是
    // `{answers: {q1: a1, q2: a2}, annotations?: {...}}` (来自 routes/answer.ts
    // 调的 registry.answer(toolUseId, {answers, annotations})). 不能直接当
    // Record<question, answer> 用 — 那样 formatAskAnswer 查每条 question
    // 都拿到 undefined, 模型看到的全是 "(no answer)" 然后瞎猜.
    // 解法: 优先取 payload.answers; 兜底顶层 (兼容直接发 flat map 的旧 schema).
    const raw = (await ctx.askRegistry.register(
      ctx.toolUseId,
      ctx.sessionId,
      signal,
    )) as Record<string, unknown>
    const answers =
      (raw.answers as Record<string, unknown> | undefined) ?? raw
    return { output: formatAskAnswer(input, answers) }
  } catch (err) {
    // 用户取消 / session abort / 超时 — 让上游走 is_error:true 路径,
    // 模型会知道这条 ask 没拿到答复, 可以 fallback 走默认行为。
    throw err instanceof Error ? err : new Error(String(err))
  }
}

export const askUserQuestionTool = makeTool({
  name: 'AskUserQuestion',
  description:
    'Ask the user a multiple-choice question (or a free-text fallback). ' +
    "Returns the user's selection. Use when you need a decision before proceeding. " +
    'Wired to zai-server AskRegistry via openccConfig.askRegistry; the ' +
    'tool yields a tool_use:ask_pending event so the frontend QuestionCard ' +
    'can render, then awaits the user\'s submit/answer.',
  inputSchema: AskUserQuestionInput,
  executor: askUserQuestionCall,
})

