// @ts-nocheck
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_OPENAI_BASE_URL,
  resolveProviderRequest,
} from '../services/api/providerConfig.ts'
import {
  getGoalDefaultOpenAIModel,
  normalizeRecommendationGoal,
  type RecommendationGoal,
} from './providerRecommendation.ts'
import { getOllamaChatBaseUrl } from './providerDiscovery.ts'
import { isEnvTruthy } from './envUtils.js'

export const PROFILE_FILE_NAME = '.claude-profile.json'

const PROFILE_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_API_FORMAT',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_SCHEME',
  'OPENAI_AUTH_HEADER_VALUE',
  'OPENAI_API_KEY',
] as const

const SECRET_ENV_KEYS = [
  'OPENAI_API_KEY',
] as const

export type ProviderProfile = 'openai' | 'ollama' | 'atomic-chat'

export type ProfileEnv = {
  OPENAI_BASE_URL?: string
  OPENAI_MODEL?: string
  OPENAI_API_FORMAT?: 'chat_completions' | 'responses'
  OPENAI_AUTH_HEADER?: string
  OPENAI_AUTH_SCHEME?: 'bearer' | 'raw'
  OPENAI_AUTH_HEADER_VALUE?: string
  OPENAI_API_KEY?: string
}

export type ProfileFile = {
  profile: ProviderProfile
  env: ProfileEnv
  createdAt: string
}

type SecretValueSource = Partial<
  Pick<
    NodeJS.ProcessEnv & ProfileEnv,
    (typeof SECRET_ENV_KEYS)[number]
  >
>

type ProfileFileLocation = {
  cwd?: string
  filePath?: string
}

function resolveProfileFilePath(options?: ProfileFileLocation): string {
  if (options?.filePath) {
    return options.filePath
  }

  return resolve(options?.cwd ?? process.cwd(), PROFILE_FILE_NAME)
}

export function isProviderProfile(value: unknown): value is ProviderProfile {
  return (
    value === 'openai' ||
    value === 'ollama' ||
    value === 'atomic-chat'
  )
}

export function sanitizeApiKey(
  key: string | null | undefined,
): string | undefined {
  if (!key || key === 'SUA_CHAVE') return undefined
  return key
}

function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false

  if (trimmed.startsWith('sk-') || trimmed.startsWith('sk-ant-')) {
    return true
  }

  return false
}

function collectSecretValues(
  sources: Array<SecretValueSource | null | undefined>,
): string[] {
  const values = new Set<string>()

  for (const source of sources) {
    if (!source) continue

    for (const key of SECRET_ENV_KEYS) {
      const value = sanitizeApiKey(source[key])
      if (value) {
        values.add(value)
      }
    }
  }

  return [...values]
}

export function maskSecretForDisplay(
  value: string | null | undefined,
): string | undefined {
  const sanitized = sanitizeApiKey(value)
  if (!sanitized) return undefined

  if (sanitized.length <= 8) {
    return 'configured'
  }

  if (sanitized.startsWith('sk-')) {
    return `${sanitized.slice(0, 3)}...${sanitized.slice(-4)}`
  }

  return `${sanitized.slice(0, 2)}...${sanitized.slice(-4)}`
}

export function redactSecretValueForDisplay(
  value: string | null | undefined,
  ...sources: Array<SecretValueSource | null | undefined>
): string | undefined {
  if (!value) return undefined

  const trimmed = value.trim()
  if (!trimmed) return trimmed

  const secretValues = collectSecretValues(sources)
  if (secretValues.includes(trimmed) || looksLikeSecretValue(trimmed)) {
    return maskSecretForDisplay(trimmed) ?? 'configured'
  }

  return trimmed
}

export function sanitizeProviderConfigValue(
  value: string | null | undefined,
  ...sources: Array<SecretValueSource | null | undefined>
): string | undefined {
  if (!value) return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  const secretValues = collectSecretValues(sources)
  if (secretValues.includes(trimmed) || looksLikeSecretValue(trimmed)) {
    return undefined
  }

  return trimmed
}

export function buildOllamaProfileEnv(
  model: string,
  options: {
    baseUrl?: string | null
    getOllamaChatBaseUrl: (baseUrl?: string) => string
  },
): ProfileEnv {
  return {
    OPENAI_BASE_URL: options.getOllamaChatBaseUrl(options.baseUrl ?? undefined),
    OPENAI_MODEL: model,
  }
}

export function buildAtomicChatProfileEnv(
  model: string,
  options: {
    baseUrl?: string | null
    getAtomicChatChatBaseUrl: (baseUrl?: string) => string
  },
): ProfileEnv {
  return {
    OPENAI_BASE_URL: options.getAtomicChatChatBaseUrl(options.baseUrl ?? undefined),
    OPENAI_MODEL: model,
  }
}

export function buildOpenAIProfileEnv(options: {
  goal: RecommendationGoal
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  apiFormat?: 'chat_completions' | 'responses' | null
  authHeader?: string | null
  authScheme?: 'bearer' | 'raw' | null
  authHeaderValue?: string | null
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const key = sanitizeApiKey(options.apiKey ?? processEnv.OPENAI_API_KEY)
  const authHeaderValue = sanitizeApiKey(
    options.authHeaderValue ?? processEnv.OPENAI_AUTH_HEADER_VALUE,
  )
  if (!key && !authHeaderValue) {
    return null
  }

  const defaultModel = getGoalDefaultOpenAIModel(options.goal)
  const shellOpenAIModel = sanitizeProviderConfigValue(
    processEnv.OPENAI_MODEL,
    { OPENAI_API_KEY: key },
    processEnv,
  )
  const shellOpenAIBaseUrl = sanitizeProviderConfigValue(
    processEnv.OPENAI_BASE_URL,
    { OPENAI_API_KEY: key },
    processEnv,
  )
  const shellOpenAIRequest = resolveProviderRequest({
    model: shellOpenAIModel,
    baseUrl: shellOpenAIBaseUrl,
    fallbackModel: defaultModel,
    apiFormat: processEnv.OPENAI_API_FORMAT,
  })
  const useShellOpenAIConfig = shellOpenAIRequest.transport !== 'codex_responses'

  return {
    OPENAI_BASE_URL:
      sanitizeProviderConfigValue(
        options.baseUrl,
        { OPENAI_API_KEY: key },
        processEnv,
      ) ||
      (useShellOpenAIConfig ? shellOpenAIBaseUrl : undefined) ||
      DEFAULT_OPENAI_BASE_URL,
    OPENAI_MODEL:
      sanitizeProviderConfigValue(
        options.model,
        { OPENAI_API_KEY: key },
        processEnv,
      ) ||
      (useShellOpenAIConfig ? shellOpenAIModel : undefined) ||
      defaultModel,
    ...(options.apiFormat ? { OPENAI_API_FORMAT: options.apiFormat } : {}),
    ...(options.authHeader ? { OPENAI_AUTH_HEADER: options.authHeader } : {}),
    ...(options.authScheme ? { OPENAI_AUTH_SCHEME: options.authScheme } : {}),
    ...(authHeaderValue ? { OPENAI_AUTH_HEADER_VALUE: authHeaderValue } : {}),
    ...(key ? { OPENAI_API_KEY: key } : {}),
  }
}

export function createProfileFile(
  profile: ProviderProfile,
  env: ProfileEnv,
): ProfileFile {
  return {
    profile,
    env,
    createdAt: new Date().toISOString(),
  }
}

export function loadProfileFile(options?: ProfileFileLocation): ProfileFile | null {
  const filePath = resolveProfileFilePath(options)
  if (!existsSync(filePath)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ProfileFile>
    if (!isProviderProfile(parsed.profile) || !parsed.env || typeof parsed.env !== 'object') {
      return null
    }

    return {
      profile: parsed.profile,
      env: parsed.env,
      createdAt:
        typeof parsed.createdAt === 'string'
          ? parsed.createdAt
          : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export function saveProfileFile(
  profileFile: ProfileFile,
  options?: ProfileFileLocation,
): string {
  const filePath = resolveProfileFilePath(options)
  writeFileSync(filePath, JSON.stringify(profileFile, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
  return filePath
}

export function deleteProfileFile(options?: ProfileFileLocation): string {
  const filePath = resolveProfileFilePath(options)
  rmSync(filePath, { force: true })
  return filePath
}

export function hasExplicitProviderSelection(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  // If env was already applied from a provider profile, preserve it.
  if (processEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED === '1') {
    return true
  }

  return processEnv.CLAUDE_CODE_USE_OPENAI !== undefined
}

export function selectAutoProfile(
  recommendedOllamaModel: string | null,
): ProviderProfile {
  return recommendedOllamaModel ? 'ollama' : 'openai'
}

export async function buildLaunchEnv(options: {
  profile: ProviderProfile
  persisted: ProfileFile | null
  goal: RecommendationGoal
  processEnv?: NodeJS.ProcessEnv
  getOllamaChatBaseUrl?: (baseUrl?: string) => string
  resolveOllamaDefaultModel?: (goal: RecommendationGoal) => Promise<string>
  getAtomicChatChatBaseUrl?: (baseUrl?: string) => string
  resolveAtomicChatDefaultModel?: () => Promise<string | null>
}): Promise<NodeJS.ProcessEnv> {
  const processEnv = options.processEnv ?? process.env
  const persistedEnv =
    options.persisted?.profile === options.profile
      ? options.persisted.env ?? {}
      : {}
  const persistedOpenAIModel = sanitizeProviderConfigValue(
    persistedEnv.OPENAI_MODEL,
    persistedEnv,
  )
  const persistedOpenAIBaseUrl = sanitizeProviderConfigValue(
    persistedEnv.OPENAI_BASE_URL,
    persistedEnv,
  )
  const persistedOpenAIApiFormat = persistedEnv.OPENAI_API_FORMAT
  const shellOpenAIModel = sanitizeProviderConfigValue(
    processEnv.OPENAI_MODEL,
    processEnv,
  )
  const shellOpenAIBaseUrl = sanitizeProviderConfigValue(
    processEnv.OPENAI_BASE_URL,
    processEnv,
  )

  const env: NodeJS.ProcessEnv = {
    ...processEnv,
    CLAUDE_CODE_USE_OPENAI: '1',
  }

  if (options.profile === 'ollama') {
    const getOllamaBaseUrl =
      options.getOllamaChatBaseUrl ?? (() => 'http://localhost:11434/v1')
    const resolveOllamaModel =
      options.resolveOllamaDefaultModel ?? (async () => 'llama3.1:8b')

    env.OPENAI_BASE_URL = persistedOpenAIBaseUrl || getOllamaBaseUrl()
    env.OPENAI_MODEL =
      persistedOpenAIModel ||
      (await resolveOllamaModel(options.goal))

    delete env.OPENAI_API_KEY

    return env
  }

  if (options.profile === 'atomic-chat') {
    const getAtomicChatBaseUrl =
      options.getAtomicChatChatBaseUrl ?? (() => 'http://127.0.0.1:1337/v1')
    const resolveModel =
      options.resolveAtomicChatDefaultModel ?? (async () => null as string | null)

    env.OPENAI_BASE_URL = persistedEnv.OPENAI_BASE_URL || getAtomicChatBaseUrl()
    env.OPENAI_MODEL =
      persistedEnv.OPENAI_MODEL ||
      (await resolveModel()) ||
      ''

    delete env.OPENAI_API_KEY

    return env
  }

  // openai profile
  const defaultOpenAIModel = getGoalDefaultOpenAIModel(options.goal)
  const shellOpenAIRequest = resolveProviderRequest({
    model: shellOpenAIModel,
    baseUrl: shellOpenAIBaseUrl,
    fallbackModel: defaultOpenAIModel,
    apiFormat: processEnv.OPENAI_API_FORMAT,
  })
  const persistedOpenAIRequest = resolveProviderRequest({
    model: persistedOpenAIModel,
    baseUrl: persistedOpenAIBaseUrl,
    fallbackModel: defaultOpenAIModel,
    apiFormat: persistedOpenAIApiFormat,
  })
  const useShellOpenAIConfig = shellOpenAIRequest.transport !== 'codex_responses'
  const usePersistedOpenAIConfig =
    (!persistedOpenAIModel && !persistedOpenAIBaseUrl) ||
    persistedOpenAIRequest.transport !== 'codex_responses'

  env.OPENAI_BASE_URL =
    (useShellOpenAIConfig ? shellOpenAIBaseUrl : undefined) ||
    (usePersistedOpenAIConfig ? persistedOpenAIBaseUrl : undefined) ||
    DEFAULT_OPENAI_BASE_URL
  env.OPENAI_MODEL =
    (useShellOpenAIConfig ? shellOpenAIModel : undefined) ||
    (usePersistedOpenAIConfig ? persistedOpenAIModel : undefined) ||
    defaultOpenAIModel
  env.OPENAI_API_KEY = processEnv.OPENAI_API_KEY || persistedEnv.OPENAI_API_KEY
  return env
}

export async function buildStartupEnvFromProfile(options?: {
  persisted?: ProfileFile | null
  goal?: RecommendationGoal
  processEnv?: NodeJS.ProcessEnv
  getOllamaChatBaseUrl?: (baseUrl?: string) => string
  resolveOllamaDefaultModel?: (goal: RecommendationGoal) => Promise<string>
}): Promise<NodeJS.ProcessEnv> {
  const processEnv = options?.processEnv ?? process.env
  const persisted = options?.persisted ?? loadProfileFile()

const profileManagedEnv = processEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED === '1'

  // The legacy single-profile file (~/.claude-profile.json) is a
  // first-run / fallback mechanism. The newer plural provider-profile
  // system (`/provider` presets + activeProviderProfileId in config) is
  // applied earlier in the bootstrap via applyActiveProviderProfileFromConfig
  // and signals completion with CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED=1.
  //
  // If the plural system has already set env, trust it — do NOT overlay the
  // legacy file. addProviderProfile() does not sync the legacy file, so a
  // stale legacy file (e.g. OpenAI defaults from an earlier manual setup)
  // would otherwise overwrite the correct plural env and surface as the
  // "banner shows gpt-4o / api.openai.com even though my saved profile is
  // Moonshot" bug.
  //
  // Saved /provider profiles should still win over provider-manager env that was
  // auto-applied during startup. Only explicit shell/flag provider selection
  // should bypass the persisted startup profile.
  if (hasExplicitProviderSelection(processEnv) && !profileManagedEnv) {
    return processEnv
  }

  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB)) {
    return processEnv
  }

  if (!persisted) {
    return processEnv
  }

  return await buildLaunchEnv({
    profile: persisted.profile,
    persisted,
    goal:
      options?.goal ??
      normalizeRecommendationGoal(processEnv.OPENCC_PROFILE_GOAL),
    processEnv,
    getOllamaChatBaseUrl:
      options?.getOllamaChatBaseUrl ?? getOllamaChatBaseUrl,
    resolveOllamaDefaultModel: options?.resolveOllamaDefaultModel,
  })
}

export function applyProfileEnvToProcessEnv(
  targetEnv: NodeJS.ProcessEnv,
  nextEnv: NodeJS.ProcessEnv,
): void {
  for (const key of PROFILE_ENV_KEYS) {
    delete targetEnv[key]
  }

  Object.assign(targetEnv, nextEnv)
}
