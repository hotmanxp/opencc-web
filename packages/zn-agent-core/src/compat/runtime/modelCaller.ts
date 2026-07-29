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
  /** Optional: zai callers may pass `Tool` shapes from opencc's SDK that omit this. */
  input_schema?: unknown
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
