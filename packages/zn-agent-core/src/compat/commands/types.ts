// @zn-ai/zn-agent-core compat shim — port of zai-agent-core commands/types.ts.
//
// Verbatim port with paths adjusted to the new package's structure:
//   - `@anthropic-ai/sdk/resources/messages` import is unchanged (SDK is a
//     direct dep of the new package too).

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages'

export type CommandSource =
  | 'builtin' | 'bundled' | 'plugin' | 'project' | 'user' | 'mcp'

export interface CommandContext {
  cwd: string
  sessionId?: string
  model?: string
  dataDir: string
  /**
   * 会话当前 transcript 消息列表(RNA: 由路由层从 TranscriptStore.read 注入)。
   * 仅命令执行需要时携带 — 命令可读 `m.type === 'assistant'` 统计 assistant
   * 轮次,无需路由另传 `assistantMessageCount`。
   *
   * Vendor 同位置字段是 `messages: Message[]`(完整 opencc Message 形状);
   * zai 端为避免把 vendor 内部类型拖入 compat 主入口,这里用最小子集
   * `{ type: string }`,命令自己用 type guard 识别角色。TranscriptStore.read
   * 返回的 `messages: unknown[]` 可直接喂进来,不需转换。
   */
  messages?: ReadonlyArray<{ type: string }>
}

export interface PromptCommand {
  type: 'prompt'
  name: string
  aliases?: string[]
  description: string
  source: CommandSource
  progressMessage: string
  contentLength: number
  argumentHint?: string
  argNames?: string[]
  allowedTools?: string[]
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
  disableModelInvocation?: boolean
  whenToUse?: string
  version?: string
  getPromptForCommand(args: string, context: CommandContext): Promise<ContentBlockParam[]>
}

export interface StatusPayload {
  sessionId?: string | null
  cwd: string
  cwdName: string
  branch: string
  model: string
  permissionMode?: string
  version: string
}

export type LocalCommandResult =
  | { kind: 'cleared' }
  | { kind: 'compacted'; removedMessages: number; summary?: string }
  | { kind: 'status'; payload: StatusPayload }
  | { kind: 'message'; text: string }
  | { kind: 'error'; message: string }

export interface LocalCommand {
  type: 'local'
  name: string
  aliases?: string[]
  description: string
  argumentHint?: string
  source: CommandSource
  isEnabled?: () => boolean
  call(args: string, context: CommandContext): Promise<LocalCommandResult>
}

export type Command = PromptCommand | LocalCommand