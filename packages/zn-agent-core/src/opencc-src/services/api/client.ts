import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKey,
  getApiKeyFromApiKeyHelper,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
} from 'src/utils/auth.js'
import {
  convertEffortValueToLevel,
  type EffortValue,
  standardEffortToOpenAI,
  type OpenAIEffortLevel,
} from 'src/utils/effort.js'
import { getUserAgent } from 'src/utils/http.js'
import { shouldUseFirstPartyAnthropicAuth } from './authRouting.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../bootstrap/state.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { importOptionalRuntimeModule } from '../../utils/optionalRuntimeModule.js'

type OptionalRuntimeImporter = typeof importOptionalRuntimeModule

let importOptionalRuntimeModuleForClient: OptionalRuntimeImporter =
  importOptionalRuntimeModule

export function _setOptionalRuntimeModuleImporterForTesting(
  importer?: OptionalRuntimeImporter,
): void {
  importOptionalRuntimeModuleForClient = importer ?? importOptionalRuntimeModule
}

function createStderrLogger(): ClientOptions['logger'] {
  return {
    error: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg, ...args) => console.error('[Anthropic SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg, ...args) => console.error('[Anthropic SDK INFO]', msg, ...args),
    debug: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK DEBUG]', msg, ...args),
  }
}

export async function getAnthropicClient({
  apiKey,
  maxRetries,
  fetchOverride,
  source,
  providerOverride,
  effortValue,
}: {
  apiKey?: string
  maxRetries: number
  fetchOverride?: ClientOptions['fetch']
  source?: string
  // @ts-ignore
  providerOverride?: ProviderOverride
  effortValue?: EffortValue
}): Promise<Anthropic> {
  // Convert the runtime effort value to the OpenAI-shaped enum the shim
  // expects. Undefined → shim falls back to descriptor/alias defaults.
  const shimReasoningEffort: OpenAIEffortLevel | undefined =
    effortValue !== undefined
      ? standardEffortToOpenAI(convertEffortValueToLevel(effortValue))
      : undefined
  const containerId = process.env.CLAUDE_CODE_CONTAINER_ID
  const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-OpenCC-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId ? { 'x-opencc-remote-container-id': containerId } : {}),
    ...(remoteSessionId
      ? { 'x-opencc-remote-session-id': remoteSessionId }
      : {}),
    // SDK consumers can identify their app/library for backend analytics
    ...(clientApp ? { 'x-client-app': clientApp } : {}),
  }

  // Log API client configuration for HFI debugging
  logForDebugging(
    `[API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: ${!!process.env.ANTHROPIC_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`,
  )

  // Add additional protection header if enabled via env var
  const additionalProtectionEnabled = isEnvTruthy(
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  const shouldUseFirstPartyAuth =
    shouldUseFirstPartyAnthropicAuth(providerOverride)

  if (shouldUseFirstPartyAuth) {
    logForDebugging('[API:auth] OAuth token check starting')
    await checkAndRefreshOAuthTokenIfNeeded()
    logForDebugging('[API:auth] OAuth token check complete')
  }

  const isClaudeAiSubscriber =
    shouldUseFirstPartyAuth && isClaudeAISubscriber()

  if (shouldUseFirstPartyAuth && !isClaudeAiSubscriber) {
    await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession())
  }

  const resolvedFetch = buildFetch(fetchOverride, source)

  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: true,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }
  // Agent routing override: use per-agent provider when configured.
  // Strip auth-related headers to prevent leaking Anthropic credentials
  // to third-party endpoints (SSRF / credential forwarding mitigation).
  if (providerOverride) {
    const { createOpenAIShimClient } = await import('./openaiShim/index.js')
    const safeHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(defaultHeaders)) {
      const lower = k.toLowerCase()
      if (lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key') continue
      safeHeaders[k] = v
    }
    return createOpenAIShimClient({
      defaultHeaders: safeHeaders,
      maxRetries,
      timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
      providerOverride,
      reasoningEffort: shimReasoningEffort,
    }) as unknown as Anthropic
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) {
    const { createOpenAIShimClient } = await import('./openaiShim/index.js')
    return createOpenAIShimClient({
      defaultHeaders,
      maxRetries,
      timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
      reasoningEffort: shimReasoningEffort,
    }) as unknown as Anthropic
  }

  // Determine authentication method based on available tokens
  const resolvedApiKey = isClaudeAISubscriber() ? null : apiKey || getAnthropicApiKey()

  const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: resolvedApiKey,
    authToken: isClaudeAISubscriber()
      ? getClaudeAIOAuthTokens()?.accessToken
      : undefined,
    // Set baseURL from OAuth config when using staging OAuth
    ...(process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.USE_STAGING_OAUTH)
      ? { baseURL: getOauthConfig().BASE_API_URL }
      : {}),
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  return new Anthropic(clientConfig)
}

async function configureApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
): Promise<void> {
  const token =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    (await getApiKeyFromApiKeyHelper(isNonInteractiveSession))
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
}

function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  // Reject raw CR characters — these indicate a header value containing \r\n
  // that would be split into an injected header entry after splitting.
  if (customHeadersEnv.includes('\r')) return customHeaders

  // Split by newlines to support multiple headers (intentional \n delimiters)
  for (const headerString of customHeadersEnv.split('\n')) {
    if (!headerString.trim()) continue
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  // Only send to the first-party API — OpenAI shim doesn't log it
  // and unknown headers risk rejection by strict proxies (inc-4029 class).
  const injectClientRequestId =
    getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    // Generate a client-side request ID so timeouts (which return no server
    // request ID) can still be correlated with server logs by the API team.
    // Callers that want to track the ID themselves can pre-set the header.
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )
    } catch {
      // never let logging crash the fetch
    }
    return inner(input, { ...init, headers })
  }
}
