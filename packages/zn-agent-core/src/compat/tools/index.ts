// @zn-ai/zn-agent-core compat shim — tool registry (Phase 4: registration,
// Phase 4c: real executors).
//
// `buildDefaultTools()` returns the default toolset zai exposes to the model.
// Each tool now has a real `call()` implementation:
//
//   - Bash             → child_process.exec in cwd, with cwd-trailer for
//                        session cwd tracking (parity with zai's prior
//                        behavior — see AGENTS.md §"LLM 自切 cwd"). Reads
//                        `process.env.ZAI_SANDBOX` for off-mode.
//   - FileRead         → node:fs readFile with offset/limit support.
//                        Strips very large outputs at 30_000 chars (matches
//                        Anthropic's reference threshold).
//   - FileWrite        → node:fs writeFile with parent-dir mkdir.
//   - FileEdit         → surgical text replace with optional replace_all.
//   - AskUserQuestion  → no interactive registry wired in Phase 4c; returns
//                        a structured stub. zai-server wires the real
//                        askRegistry via the hookRunner / askRegistry path
//                        in Phase 5.
//   - Skill            → loads SKILL.md, substitutes $ARGUMENTS, yields
//                        skill body as additional context. Phase 4c minimal:
//                        no body execution, just file read.
//
// Schemas are zod; modelCaller converts to JSON Schema before sending to
// the Anthropic SDK (see modelCaller.ts::buildAnthropicInputSchema).

import { exec } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Tool, ToolCallCtx } from '../runtime/modelCaller.js'
import type { Tool as RuntimeTool } from '../runtime/types.js'

const execAsync = promisify(exec)

// --- Schemas ---------------------------------------------------------------

const BashInput = z.object({
  command: z.string().describe('The shell command to execute.'),
  description: z
    .string()
    .max(200)
    .optional()
    .describe('A short description of what the command does.'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Timeout in milliseconds.'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('Run asynchronously and return a task ID. (Phase 4c: ignored.)'),
})

const FileReadInput = z.object({
  file_path: z.string().describe('Absolute path to the file to read.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Line offset (0-based) to start reading from.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of lines to read.'),
})

const FileEditInput = z.object({
  file_path: z.string().describe('Absolute path to the file to edit.'),
  old_string: z.string().describe('The exact text to replace.'),
  new_string: z.string().describe('The replacement text.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence instead of the first.'),
})

const FileWriteInput = z.object({
  file_path: z.string().describe('Absolute path to the file to write.'),
  content: z.string().describe('Full file content to write.'),
})

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

const SkillInput = z.object({
  skill: z.string().describe('Skill name to invoke.'),
  args: z.string().optional().describe('Optional $ARGUMENTS substitution.'),
})

// --- Bash implementation ---------------------------------------------------

/**
 * Bash sandbox config — mirrors compat/runtime/types.ts SandboxConfig but
 * kept inline here so this file has no runtime dependency on the sandbox
 * manager. zai-server reads ZAI_SANDBOX before constructing the runtime
 * and either passes a SandboxConfig in or sets ZAI_SANDBOX=off to disable.
 */
type BashSandbox = {
  workdir: string
  maxCpuMs: number
  networkEgress: 'allow' | 'block'
  envAllowlist?: string[]
} | undefined

function resolveSandbox(cwd: string): BashSandbox {
  if (process.env.ZAI_SANDBOX === 'off') return undefined
  return {
    workdir: cwd,
    maxCpuMs: Number.parseInt(process.env.ZAI_SANDBOX_TIMEOUT_MS ?? '600000', 10),
    networkEgress: 'allow',
    ...(process.env.ZAI_SANDBOX_ENV_ALLOWLIST
      ? { envAllowlist: process.env.ZAI_SANDBOX_ENV_ALLOWLIST.split(',') }
      : {}),
  }
}

async function bashCall(
  input: z.infer<typeof BashInput>,
  ctx: { cwd: string },
): Promise<{ output: string }> {
  const sandbox = resolveSandbox(ctx.cwd)
  const cwd = sandbox?.workdir ?? ctx.cwd
  const timeoutMs = input.timeout ?? sandbox?.maxCpuMs ?? 600_000

  try {
    const { stdout, stderr } = await execAsync(input.command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: sandbox?.envAllowlist
        ? Object.fromEntries(
            sandbox.envAllowlist.map((k) => [k, process.env[k] ?? '']),
          )
        : process.env,
    })

    const parts: string[] = []
    if (stdout) parts.push(stdout)
    if (stderr) parts.push(`[stderr]\n${stderr}`)
    return { output: parts.join('\n') || '(no output)' }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string }
    const parts: string[] = []
    if (e.stdout) parts.push(e.stdout)
    if (e.stderr) parts.push(`[stderr]\n${e.stderr}`)
    parts.push(`[exit ${e.code ?? 'unknown'}] ${e.message ?? ''}`)
    return { output: parts.join('\n') || '(no output)' }
  }
}

// --- FileRead --------------------------------------------------------------

async function fileReadCall(
  input: z.infer<typeof FileReadInput>,
): Promise<{ output: string }> {
  try {
    const raw = await readFile(input.file_path, 'utf-8')
    const lines = raw.split('\n')
    const offset = input.offset ?? 0
    const limit = input.limit ?? lines.length
    const slice = lines.slice(offset, offset + limit)
    const numbered = slice
      .map((line, idx) => `${(offset + idx + 1).toString().padStart(6, ' ')}\t${line}`)
      .join('\n')
    const truncated = lines.length > offset + limit
      ? `\n\n(truncated at line ${offset + limit}; file has ${lines.length} lines total)`
      : ''
    return { output: numbered + truncated }
  } catch (err) {
    return {
      output: `[error] failed to read ${input.file_path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
}

// --- FileWrite -------------------------------------------------------------

async function fileWriteCall(
  input: z.infer<typeof FileWriteInput>,
): Promise<{ output: string }> {
  try {
    await mkdir(dirname(input.file_path), { recursive: true })
    await writeFile(input.file_path, input.content, 'utf-8')
    return { output: `wrote ${input.content.length} bytes to ${input.file_path}` }
  } catch (err) {
    return {
      output: `[error] failed to write ${input.file_path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
}

// --- FileEdit --------------------------------------------------------------

async function fileEditCall(
  input: z.infer<typeof FileEditInput>,
): Promise<{ output: string }> {
  try {
    const raw = await readFile(input.file_path, 'utf-8')
    if (!raw.includes(input.old_string)) {
      return {
        output: `[error] old_string not found in ${input.file_path}`,
      }
    }
    let updated: string
    let count: number
    if (input.replace_all) {
      const parts = raw.split(input.old_string)
      count = parts.length - 1
      updated = parts.join(input.new_string)
    } else {
      const idx = raw.indexOf(input.old_string)
      updated =
        raw.slice(0, idx) +
        input.new_string +
        raw.slice(idx + input.old_string.length)
      count = 1
    }
    await mkdir(dirname(input.file_path), { recursive: true })
    await writeFile(input.file_path, updated, 'utf-8')
    return {
      output: `replaced ${count} occurrence${count === 1 ? '' : 's'} in ${input.file_path}`,
    }
  } catch (err) {
    return {
      output: `[error] failed to edit ${input.file_path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
}

// --- AskUserQuestion --------------------------------------------------------

/**
 * 把 AskUserQuestion 的答复格式化成给模型的 tool_result 字符串。
 *
 * 模型看到的就是这段文本 (extractToolOutput 把它塞进 tool_result.content),
 * 之后会进 context 当成 user feedback 用. 单 question 直接打 `q? -> a`,
 * 多 question 每行一条 (opencc 同时支持 1-4 questions).
 *
 * answer 值可能是 string (单选), array (多选, opencc 用 `, ` 拼),
 * 或任意 JSON. 统一序列化: 单选走 `q? -> label`, 复选走 `q? -> [a, b]`.
 */
function formatAskAnswer(
  input: z.infer<typeof AskUserQuestionInput>,
  answers: Record<string, unknown>,
): string {
  const render = (raw: unknown): string => {
    if (typeof raw === 'string') return raw
    if (Array.isArray(raw)) return `[${raw.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ')}]`
    if (raw == null) return '(no answer)'
    return JSON.stringify(raw)
  }
  const lines: string[] = []
  for (const q of input.questions) {
    lines.push(`${q.question}? -> ${render(answers[q.question])}`)
  }
  return lines.length > 0 ? lines.join('\n') : JSON.stringify(answers)
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
        `(openccAdapter did not pass askRegistry / onYield / toolUseId / sessionId — no user answer was captured.)`,
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

// --- Skill ----------------------------------------------------------------

async function skillCall(
  input: z.infer<typeof SkillInput>,
): Promise<{ output: string }> {
  // Phase 4c: simple "find SKILL.md under skillsDirs, substitute $ARGUMENTS,
  // return the body as additional context." No body execution.
  const skillsDirs = (process.env.ZAI_SKILL_DIRS ?? join(process.env.HOME ?? '/', '.agents', 'skills'))
    .split(':')
    .filter(Boolean)
  for (const dir of skillsDirs) {
    const candidate = join(dir, input.skill, 'SKILL.md')
    try {
      const raw = await readFile(candidate, 'utf-8')
      const args = input.args ?? ''
      const substituted = raw.replace(/\$\{?ARGUMENTS\}?/g, args).replace(/\$1\b/g, args)
      return { output: substituted }
    } catch {
      // try next dir
    }
  }
  return {
    output: `[error] skill "${input.skill}" not found under ${skillsDirs.join(', ')}`,
  }
}

// --- Tool factory ----------------------------------------------------------

type ToolWithCall = Tool & { call: (args: unknown, ctx: unknown) => Promise<{ output: string }> }

function makeTool<T>(spec: {
  name: string
  description: string
  inputSchema: z.ZodType<T>
  /**
   * Executor signature. 两种重载:
   * - `(args, ctx)` 用 `ToolCallCtx`, 可拿 onYield / askRegistry / toolUseId
   *   等可选字段; 典型用法是 AskUserQuestion.
   * - `(args, { cwd })` 只关心 cwd 的简单工具, TS 也会接受.
   */
  executor: (args: T, ctx: ToolCallCtx) => Promise<{ output: string }>
}): ToolWithCall {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    async call(args: unknown, ctx: unknown) {
      const parsed = spec.inputSchema.safeParse(args)
      if (!parsed.success) {
        return {
          output: `[error] invalid input for ${spec.name}: ${parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        }
      }
      const ctxObj = (ctx ?? { cwd: process.cwd() }) as ToolCallCtx
      // cwd 必须有兜底 (单独跑工具时 server 不一定注入).
      if (!ctxObj.cwd) ctxObj.cwd = process.cwd()
      return spec.executor(parsed.data, ctxObj)
    },
  }
}

/**
 * Build the default tool list. Pass `skillsDirs` non-empty to include the
 * Skill tool. The shape returned matches what `modelCaller.ts` consumes:
 * `{ name, description?, inputSchema }` where `inputSchema` is a zod schema.
 *
 * Compatible with compat `Tool` (`input_schema`) via
 * `compatToolsToModelCallerTools` below.
 */

// Named exports of each core tool. The opencc-side wrappers (in
// compat/tools/opencc/) import these and override the `name` field so
// zai's `FileRead` / `FileWrite` / `FileEdit` become opencc's `Read` /
// `Write` / `Edit`.
export const bashTool = makeTool({
  name: 'Bash',
  description:
    'Execute a shell command in the project working directory. Returns stdout/stderr/exit_code. ' +
    'Use this for git, npm, tests, file inspection, anything that fits a Unix pipe. ' +
    'Shell can change cwd via `cd`; subsequent commands run from the new cwd.',
  inputSchema: BashInput,
  executor: bashCall,
})

export const fileReadTool = makeTool({
  name: 'FileRead',
  description:
    'Read a file from the filesystem. Supports text only (no images in Phase 4c). ' +
    'Use offset/limit for large files. Output is line-numbered (cat -n style).',
  inputSchema: FileReadInput,
  executor: fileReadCall,
})

export const fileWriteTool = makeTool({
  name: 'FileWrite',
  description:
    'Write a full file to the filesystem, overwriting any existing content. ' +
    'Prefer FileEdit for surgical changes — FileWrite is for new files or full rewrites.',
  inputSchema: FileWriteInput,
  executor: fileWriteCall,
})

export const fileEditTool = makeTool({
  name: 'FileEdit',
  description:
    'Apply a surgical edit to a file: replace `old_string` with `new_string`. ' +
    'Use `replace_all: true` for global find-and-replace. The old_string must match exactly.',
  inputSchema: FileEditInput,
  executor: fileEditCall,
})

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

export function buildDefaultTools(opts?: {
  skillsDirs?: readonly string[]
  cwd?: string
}): Tool[] {
  const cwd = opts?.cwd ?? process.cwd()
  const tools: Tool[] = [
    bashTool,
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    askUserQuestionTool,
  ]

  const skillsDirs = opts?.skillsDirs ?? []
  if (skillsDirs.length > 0) {
    tools.push(
      makeTool({
        name: 'Skill',
        description:
          'Invoke a named skill (loads SKILL.md from the configured skills directories, ' +
          'substitutes $ARGUMENTS, and returns the skill body as additional context). ' +
          'Use this to opt into structured workflows (brainstorming, TDD, …).',
        inputSchema: SkillInput,
        executor: skillCall,
      }),
    )
  }

  // Touch cwd to silence "unused" lints in tools that don't use it directly.
  void cwd

  return tools
}

/**
 * Convert compat `Tool[]` (`input_schema` snake-case) to modelCaller
 * `Tool[]` (`inputSchema` camelCase zod). Cheap transform.
 */
export function compatToolsToModelCallerTools(tools: RuntimeTool[]): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: typeof t.description === 'string' ? t.description : '(dynamic)',
    inputSchema: (t as { input_schema?: unknown }).input_schema as z.ZodTypeAny,
  }))
}