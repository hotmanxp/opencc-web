export { createOpenAIShimClient } from './openaiClient.ts'

// Re-export from sub-modules
export type { AnthropicUsage, AnthropicStreamEvent, ShimCreateParams } from './types.ts'
export type { OpenAIMessage, OpenAITool, OpenAIStreamChunk } from './types.ts'
export type { SecretValueSource } from './types.ts'

export {
  GEMINI_API_HOST,
  MOONSHOT_API_HOSTS,
  SENSITIVE_URL_QUERY_PARAM_NAMES,
  isMistralMode,
  isGithubModelsMode,
} from './constants.ts'

export {
  filterAnthropicHeaders,
  hasGeminiApiHost,
  hasCerebrasApiHost,
  isMoonshotBaseUrl,
  formatRetryAfterHint,
  shouldRedactUrlQueryParam,
  redactUrlForDiagnostics,
  sleepMs,
  getLocalProviderRetryBaseUrls,
  shouldAttemptLocalToollessRetry,
} from './providerUtils.ts'

export {
  convertSystemPrompt,
  convertToolResultContent,
  convertContentBlocks,
  isGeminiMode,
  convertMessages,
} from './messageConversion.ts'

export {
  normalizeSchemaForOpenAI,
  convertTools,
} from './schemaNormalization.ts'

export {
  JSON_REPAIR_SUFFIXES,
  makeMessageId,
  convertChunkUsage,
  repairPossiblyTruncatedObjectJson,
  readWithTimeout,
  readWithIdleTimeout,
  STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_STREAM_IDLE_TIMEOUT_MS,
  StreamIdleTimeoutError,
  getStreamIdleTimeoutMs,
  __test,
} from './streaming.ts'

export { openaiStreamToAnthropic } from './openaiStreamToAnthropic.ts'
export { anthropicSsePassthrough } from './anthropicSsePassthrough.ts'
