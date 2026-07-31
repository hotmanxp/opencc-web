/**
 * zai-specific ModelCaller type contract.
 *
 * This type is a zai-side invention; opencc's runtime doesn't expose
 * anything with this exact shape (opencc's SDK uses its own internal
 * streaming interface). We define it here so that zai's modelCaller.ts
 * (the factory) and runtime consumers share a stable contract.
 *
 * NOTE: when the new package's runtime grows its own SDK integration,
 * this type will likely move / evolve. For now it's verbatim-ported
 * from the old zai-agent-core runtime/types.ts.
 */

export interface Tool {
  name: string
  /**
   * Tool description. Either a static string (zai-native tools) or a
   * function returning a Promise<string> (opencc SDK tools). The shape is
   * intentionally permissive (`Function` rather than a typed callback) so
   * callers from either source can flow through without a cast — opencc's
   * SDK takes `(input, options)` while the zai-native form takes nothing.
   */
  description: string | Function
  /**
   * zod input schema. Phase 4 buildDefaultTools() returns zod schemas
   * directly; modelCaller calls zodToJsonSchema() on this before sending
   * to the Anthropic SDK. The compat/runtime/types.ts `Tool` type keeps
   * `input_schema?: unknown` (snake-case) for back-compat with the
   * upstream-verbatim port — see compatToolsToModelCallerTools() in
   * compat/tools/index.ts for the cross-shape transform.
   */
  inputSchema?: unknown
  /**
   * Tool execution. Optional — Phase 4 buildDefaultTools() wires a stub
   * `call` for each registered tool; Phase 5 replaces stubs with real
   * Bash/Read/Write/Edit/AskUserQuestion implementations. The opencc
   * query bridge's tool-use loop invokes this when the model emits a
   * `content_block_start { type: 'tool_use' }` block.
   *
   * Args: (input, ctx) where:
   *   - input: the parsed JSON from the model's tool_use block (validated
   *     by the tool's zod schema inside the executor).
   *   - ctx:  runtime context. 最小只要求 `{ cwd }`; the opencc query
   *     bridge 在调工具时还会塞 sessionId / toolUseId / abortSignal /
   *     askRegistry / onYield 等可选字段 — 见 `ToolCallCtx`。
   *
   * Returns: `{ output: string }` (preferred) or any value with a string
   * `output` / `content` field that the adapter flattens.
   */
  call?: (args: unknown, ctx?: ToolCallCtx) => Promise<unknown>
}

/**
 * opencc query bridge 传给 `Tool.call(input, ctx)` 的上下文。
 *
 * `cwd` / `sessionId` / `toolUseId` / `abortSignal` 是只读元数据;
 * `onYield` 允许工具 (典型是 AskUserQuestion) 在执行中途向 SSE 通道推
 * 事件 — adapter 会把 onYield 推的事件先 buffer, 在 tool.call resolve
 * 之后立即 yiled 到上游, 保证事件顺序 (tool_use:start → ask_pending →
 * tool_result) 与 translateRuntimeEvents 的 switch 顺序对齐.
 *
 * `askRegistry` 是 server 端 AskRegistry 的抽象. AskUserQuestion 用它
 * 注册/等待用户答复; 没注入时 (例如单测) 走 stub fallback.
 */
export type ToolCallCtx = {
  cwd: string
  sessionId?: string
  toolUseId?: string
  abortSignal?: AbortSignal
  /**
   * Push a `RuntimeEvent` to be emitted on the adapter's async generator
   * after the current `tool.call` resolves. Synchronous only — async
   * generators inside the tool should call this in order, not await it.
   */
  onYield?: (event: Record<string, unknown>) => void
  /**
   * AskRegistry abstraction. AskUserQuestion 调用 `register(toolUseId, sessionId, abortSignal)`
   * 阻塞等待用户答复; resolve 时拿到 `{ questionText: selectedLabel, ... }` map.
   */
  askRegistry?: import('./types.js').AskRegistryLike
  /**
   * Skills discovered by the runtime — merged disk + plugin skills. The
   * `Skill` tool uses this to look up `SKILL.md` by name when the model
   * invokes a skill that came from a plugin (e.g. superpowers). Without
   * this, plugin skills show up in the `<skills>` block but the tool
   * can't find them on disk because the directory-walk only knew about
   * `skillsDirs`.
   */
  skills?: import('./skills-types.js').LoadedSkill[]
}

export type ModelCaller = (req: {
  model: string
  systemPrompt: string | string[] | Array<{ type: string; [key: string]: unknown }>
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
  tools: Tool[]
  signal: AbortSignal
}) => AsyncGenerator<{
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'error'
  [key: string]: unknown
}>
