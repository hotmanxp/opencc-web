export type OpenccRuntimeOptions = {
  dataDir: string
  runtimeId?: string
  defaultCwd?: string
  defaultModel?: string
}

export type OpenccQueryInput = {
  sessionId: string
  prompt: string
  cwd?: string
  model?: string
  abortSignal?: AbortSignal
}

export type OpenccServerEvent = {
  eventId: string
  sessionId: string
  ts: number
  turnIndex: number
  type: string
  [key: string]: unknown
}

export type OpenccSession = {
  id: string
  cwd: string
  filePath: string
  createdAt: number
  updatedAt: number
  messageCount: number
  [key: string]: unknown
}

export type OpenccRuntime = {
  query(input: OpenccQueryInput): AsyncIterable<OpenccServerEvent>
  abort(sessionId: string, reason?: string): Promise<void>
  getSession(sessionId: string): Promise<OpenccSession | null>
  listSessions(opts?: { cwd?: string; limit?: number }): Promise<OpenccSession[]>
  readTranscript(sessionId: string): Promise<string>
  patchSession(sessionId: string, patch: Record<string, unknown>): Promise<void>
  removeSession(sessionId: string): Promise<boolean>
  shutdown(): Promise<void>
}

export type CreateOpenccRuntimeOptions = OpenccRuntimeOptions & {
  modelCaller?: (request: unknown) => AsyncIterable<unknown>
  query?: (params: unknown) => AsyncIterable<unknown>
}

export const createOpenccRuntime = async (options: CreateOpenccRuntimeOptions): Promise<OpenccRuntime> => {
  const mod = await import('./createOpenccRuntime-impl.js')
  return mod.createOpenccRuntimeImpl(options)
}
