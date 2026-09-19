/**
 * Convert cua-driver MCP image content blocks into Anthropic SDK image blocks.
 *
 * cua-driver uses `{ type: 'image', mimeType, data }` (camelCase `mimeType`),
 * but the Anthropic API expects `{ type: 'image', source: { type: 'base64',
 * media_type, data } }` (snake_case `media_type`). MCPTool's default
 * mapToolResultToToolResultBlockParam passes the content array through
 * unchanged, which the Anthropic SDK rejects — so every cua-driver tool gets
 * this projector via the per-tool override at the tools-list site in
 * services/mcp/client.ts.
 *
 * Non-image blocks are coerced to text blocks so the Anthropic content schema
 * stays satisfied. Unknown block shapes become a JSON-bounded diagnostic text
 * block.
 *
 * Lives in its own file (rather than alongside the rest of client.ts) so the
 * pure projection logic is importable from tests without dragging in the 100+
 * modules client.ts transitively pulls (BashTool, agent runtime, ink, etc.).
 *
 * @module
 */
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'

type AnthropicToolResultBlockParam = {
  tool_use_id: string
  type: 'tool_result'
  content: string | ContentBlockParam[]
}

type CuImageBlock = { type: 'image'; mimeType?: unknown; data?: unknown }
type CuTextBlock = { type: 'text'; text?: unknown }

export function projectCuaDriverImageBlocks(
  content: unknown,
  toolUseID: string,
): AnthropicToolResultBlockParam {
  if (!Array.isArray(content)) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: typeof content === 'string' ? content : '',
    }
  }
  const projected: ContentBlockParam[] = content.map((block: unknown) => {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'image'
    ) {
      const b = block as CuImageBlock
      const mediaType =
        typeof b.mimeType === 'string'
          ? (b.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp')
          : ('image/jpeg' as const)
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: typeof b.data === 'string' ? b.data : '',
        },
      } as ContentBlockParam
    }
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text'
    ) {
      const t = (block as CuTextBlock).text
      return {
        type: 'text',
        text: typeof t === 'string' ? t : '',
      } as ContentBlockParam
    }
    return {
      type: 'text',
      text: `[unsupported cua-driver content block: ${JSON.stringify(block).slice(0, 200)}]`,
    } as ContentBlockParam
  })
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: projected,
  }
}