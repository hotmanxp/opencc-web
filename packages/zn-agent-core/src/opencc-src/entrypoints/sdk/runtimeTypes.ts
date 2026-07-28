// Runtime types for SDK - stub definitions
// This file should contain non-serializable types (callbacks, interfaces with methods)

export type EffortLevel = 'low' | 'medium' | 'high' | 'max' | 'ultracode'

// Types needed for agentSdkTypes.ts
export type AnyZodRawShape = Record<string, unknown>

export type InferShape<T extends AnyZodRawShape> = {
  [K in keyof T]: T[K] extends { parse: (input: unknown) => infer R } ? R : never
}

export type InternalOptions = {
  model?: string
  maxTokens?: number
}

export type InternalQuery = {
  promise: Promise<unknown>
}

export type Options = {
  model?: string
}

export type Query = {
  promise: Promise<unknown>
}

export type SDKSession = {
  id: string
}

export type SDKSessionOptions = {
  dir?: string
  model?: string
}

export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
}

export type GetSessionInfoOptions = {
  dir?: string
}

export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}

export type SessionMutationOptions = {
  dir?: string
}

export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}

export type ForkSessionResult = {
  sessionId: string
}

export type SDKSessionInfo = {
  sessionId: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export type SessionMessage = {
  type: string
  uuid: string
  content: string
}

export type McpSdkServerConfigWithInstance = {
  name: string
  version?: string
}

// Tool definition type
export type SdkMcpToolDefinition<Schema extends AnyZodRawShape = Record<string, unknown>> = {
  name: string
  description: string
  inputSchema: Schema
}
