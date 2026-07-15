import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages'

export type CommandSource =
  | 'builtin' | 'bundled' | 'plugin' | 'project' | 'user' | 'mcp'

export interface CommandContext {
  cwd: string
  sessionId?: string
  model?: string
  dataDir: string
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