// @ts-nocheck
export { createOpenAIShimClient } from './openaiClient.js'

// Re-export from sub-modules
export type { AnthropicUsage, AnthropicStreamEvent, ShimCreateParams } from './types.js'
export type { OpenAIMessage, OpenAITool, OpenAIStreamChunk } from './types.js'
export type { SecretValueSource } from './types.js'

export {
  GEMINI_API_HOST,
  MOONSHOT_API_HOSTS,
  SENSITIVE_URL_QUERY_PARAM_NAMES,
  isMistralMode,
  isGithubModelsMode,
} from './constants.js'

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
} from './providerUtils.js'

export {
  convertSystemPrompt,
  convertToolResultContent,
  convertContentBlocks,
  isGeminiMode,
  convertMessages,
} from './messageConversion.js'

export {
  normalizeSchemaForOpenAI,
  convertTools,
} from './schemaNormalization.js'

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
} from './streaming.js'

export { openaiStreamToAnthropic } from './openaiStreamToAnthropic.js'
export { anthropicSsePassthrough } from './anthropicSsePassthrough.js'
