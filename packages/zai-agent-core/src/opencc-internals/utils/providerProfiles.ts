// @ts-nocheck
import { randomBytes } from 'crypto'
import {
  isCodexBaseUrl,
  parseOpenAICompatibleApiFormat,
} from '../services/api/providerConfig.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
  type ProviderProfile,
} from './config.js'
import { getSettings_DEPRECATED } from './settings/settings.js'
import type { ProfileEnv } from './providerProfile.js'
import { buildOpenAIProfileEnv } from './providerProfile.js'
import type { ModelOption } from './model/modelOptions.js'
import { getPrimaryModel, parseModelList } from './providerModels.js'
import { isModelAlias } from './model/aliases.js'

export type ProviderPreset =
  | 'anthropic'
  | 'ollama'
  | 'openai'
  | 'custom'

export type ProviderProfileInput = {
  provider?: ProviderProfile['provider']
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  apiFormat?: ProviderProfile['apiFormat']
  authHeader?: ProviderProfile['authHeader']
  authScheme?: ProviderProfile['authScheme']
  authHeaderValue?: ProviderProfile['authHeaderValue']
}

export type ProviderPresetDefaults = Omit<ProviderProfileInput, 'provider'> & {
  provider: ProviderProfile['provider']
  requiresApiKey: boolean
}

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1'
const DEFAULT_OLLAMA_MODEL = 'llama3.1:8b'
const PROFILE_ENV_APPLIED_FLAG = 'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED'
const PROFILE_ENV_APPLIED_ID = 'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID'

function trimValue(value: string | undefined): string {
  return value?.trim() ?? ''
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = trimValue(value)
  return trimmed.length > 0 ? trimmed : undefined
}

function sanitizeAuthHeader(value: string | undefined): string | undefined {
  const trimmed = trimOrUndefined(value)
  if (!trimmed) {
    return undefined
  }
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(trimmed)
    ? trimmed
    : undefined
}

function sanitizeAuthScheme(value: string | undefined): ProviderProfile['authScheme'] | undefined {
  return value === 'raw' || value === 'bearer' ? value : undefined
}

function normalizeBaseUrl(value: string): string {
  return trimValue(value).replace(/\/+$/, '')
}

function sanitizeProfile(profile: ProviderProfile): ProviderProfile | null {
  const id = trimValue(profile.id)
  const name = trimValue(profile.name)
  const provider = profile.provider === 'anthropic' ? 'anthropic' : 'openai'
  const baseUrl = normalizeBaseUrl(profile.baseUrl)
  const model = trimValue(profile.model)
  const apiFormat = parseOpenAICompatibleApiFormat(profile.apiFormat)
  const authHeader = sanitizeAuthHeader(profile.authHeader)
  const authScheme = sanitizeAuthScheme(profile.authScheme)
  const authHeaderValue = trimOrUndefined(profile.authHeaderValue)

  if (!id || !name || !baseUrl || !model) {
    return null
  }

  const sanitized: ProviderProfile = {
    id,
    name,
    provider,
    baseUrl,
    model,
    apiKey: trimOrUndefined(profile.apiKey),
  }
  if (provider === 'openai' && apiFormat) {
    sanitized.apiFormat = apiFormat
  }
  if (provider === 'openai' && authHeader) {
    sanitized.authHeader = authHeader
    sanitized.authScheme = authScheme ?? (
      authHeader.toLowerCase() === 'authorization' ? 'bearer' : 'raw'
    )
    sanitized.authHeaderValue = authHeaderValue
  }
  return sanitized
}

function sanitizeProfiles(profiles: ProviderProfile[] | undefined): ProviderProfile[] {
  const seen = new Set<string>()
  const sanitized: ProviderProfile[] = []

  for (const profile of profiles ?? []) {
    const normalized = sanitizeProfile(profile)
    if (!normalized || seen.has(normalized.id)) {
      continue
    }
    seen.add(normalized.id)
    sanitized.push(normalized)
  }

  return sanitized
}

function nextProfileId(): string {
  return `provider_${randomBytes(6).toString('hex')}`
}

function toProfile(
  input: ProviderProfileInput,
  id: string = nextProfileId(),
): ProviderProfile | null {
  return sanitizeProfile({
    id,
    provider: input.provider ?? 'openai',
    name: input.name,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey,
    apiFormat: input.apiFormat,
    authHeader: input.authHeader,
    authScheme: input.authScheme,
    authHeaderValue: input.authHeaderValue,
  })
}

function getModelCacheByProfile(
  profileId: string,
  config = getGlobalConfig(),
): ModelOption[] {
  return config.openaiAdditionalModelOptionsCacheByProfile?.[profileId] ?? []
}

export function getProviderPresetDefaults(
  preset: ProviderPreset,
): ProviderPresetDefaults {
  switch (preset) {
    case 'anthropic':
      return {
        provider: 'anthropic',
        name: 'Anthropic',
        baseUrl: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
        model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
        apiKey: process.env.ANTHROPIC_API_KEY ?? '',
        requiresApiKey: true,
      }
    case 'openai': {
      // Also check settings.json env as fallback
      const settingsEnv = getSettings_DEPRECATED()?.env
      const settingsOpenAIUrl = settingsEnv?.OPENAI_BASE_URL
      return {
        provider: 'openai',
        name: 'OpenAI',
        baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        model: process.env.OPENAI_MODEL ?? 'zhiniao-MiniMax-M2.7-highspeed',
        apiKey: process.env.OPENAI_API_KEY ?? '',
        requiresApiKey: true,
      }
    }
    case 'ollama':
    case 'custom':
    default: {
      // Also check settings.json env as fallback (covers cases where env vars are
      // not set in shell but configured in settings.json)
      const settingsEnv = getSettings_DEPRECATED()?.env
      const settingsOpenAIUrl = settingsEnv?.OPENAI_BASE_URL
      return {
        provider: 'openai',
        name: preset === 'ollama' ? 'Ollama' : 'Custom OpenAI-compatible',
        baseUrl:
          process.env.OPENAI_BASE_URL ??
          settingsOpenAIUrl ??
          process.env.OPENAI_API_BASE ??
          DEFAULT_OLLAMA_BASE_URL,
        model: process.env.OPENAI_MODEL ?? DEFAULT_OLLAMA_MODEL,
        apiKey: process.env.OPENAI_API_KEY ?? '',
        requiresApiKey: false,
      }
    }
  }
}

/**
 * Return the default (first) model from a profile's model field.
 * The model field can be a single model name or a comma/semicolon-separated
 * list. Returns null when the field is empty or whitespace-only.
 *
 * Used by maybeResetMainLoopModel to decide what mainLoopModel should be
 * reset to when this profile is activated mid-session.
 */
export function getDefaultModelForProfile(profile: ProviderProfile): string | null {
  const models = parseModelList(profile.model)
  return models.length > 0 ? models[0] : null
}

/**
 * Decide whether the session's mainLoopModel should be reset when the user
 * activates `activeProfile` via /provider → "Set active provider".
 *
 * Pure function — does not mutate AppState. The caller (ProviderManager.tsx
 * select-active onSelect) owns the setAppState call.
 *
 * Rules (evaluated in order):
 * 1. If profile has no default model → no reset.
 * 2. If currentModel is undefined/null/empty → reset to defaultModel.
 * 3. If currentModel === defaultModel → skip (already aligned).
 * 4. If currentModel is a model alias (opus/sonnet/haiku/best/...) → skip
 *    (preserves user's alias-based selection).
 * 5. Otherwise → reset, returning previousModel + newModel for caller to use
 *    in user-facing status message.
 */
export function maybeResetMainLoopModel(
  activeProfile: ProviderProfile,
  currentModel: string | undefined | null,
): { reset: boolean; previousModel?: string; newModel?: string } {
  const defaultModel = getDefaultModelForProfile(activeProfile)
  if (defaultModel === null) {
    return { reset: false }
  }

  if (currentModel === undefined || currentModel === null || currentModel === '') {
    return { reset: true, newModel: defaultModel }
  }

  if (currentModel === defaultModel) {
    return { reset: false }
  }

  if (isModelAlias(currentModel)) {
    return { reset: false }
  }

  return { reset: true, previousModel: currentModel, newModel: defaultModel }
}

export function getProviderProfiles(
  config = getGlobalConfig(),
): ProviderProfile[] {
  return sanitizeProfiles(config.providerProfiles)
}

export function hasProviderProfiles(config = getGlobalConfig()): boolean {
  return getProviderProfiles(config).length > 0
}

function hasProviderSelectionFlags(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return processEnv.CLAUDE_CODE_USE_OPENAI !== undefined
}

/**
 * A "complete" explicit provider selection = a USE flag AND at least one
 * concrete config value that tells us WHERE to route (a base URL) or WHAT
 * to run (a model id). A bare `CLAUDE_CODE_USE_OPENAI=1` with nothing else
 * is almost always a stale shell export from a previous session, not real
 * intent — and if we respect it, we skip the user's saved active profile
 * and fall back to hardcoded defaults (gpt-4o / api.openai.com), which is
 * the exact bug users report as "my saved provider isn't picked up".
 *
 * Used to gate whether saved-profile env should override shell state at
 * startup. The weaker `hasProviderSelectionFlags` is still used for the
 * anthropic-profile conflict check (any flag is a conflict for
 * first-party anthropic) and for alignment fingerprinting.
 */
function hasCompleteProviderSelection(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!hasProviderSelectionFlags(processEnv)) return false
  if (processEnv.CLAUDE_CODE_USE_OPENAI !== undefined) {
    return (
      trimOrUndefined(processEnv.OPENAI_BASE_URL) !== undefined ||
      trimOrUndefined(processEnv.OPENAI_API_BASE) !== undefined ||
      trimOrUndefined(processEnv.OPENAI_MODEL) !== undefined
    )
  }
  if (processEnv.CLAUDE_CODE_USE_GEMINI !== undefined) {
    return (
      trimOrUndefined(processEnv.GEMINI_BASE_URL) !== undefined ||
      trimOrUndefined(processEnv.GEMINI_MODEL) !== undefined ||
      trimOrUndefined(processEnv.GEMINI_API_KEY) !== undefined ||
      trimOrUndefined(processEnv.GOOGLE_API_KEY) !== undefined
    )
  }
  if (processEnv.CLAUDE_CODE_USE_MISTRAL !== undefined) {
    return (
      trimOrUndefined(processEnv.MISTRAL_BASE_URL) !== undefined ||
      trimOrUndefined(processEnv.MISTRAL_MODEL) !== undefined ||
      trimOrUndefined(processEnv.MISTRAL_API_KEY) !== undefined
    )
  }
  if (processEnv.CLAUDE_CODE_USE_GITHUB !== undefined) {
    return (
      trimOrUndefined(processEnv.GITHUB_TOKEN) !== undefined ||
      trimOrUndefined(processEnv.GH_TOKEN) !== undefined ||
      trimOrUndefined(processEnv.OPENAI_MODEL) !== undefined
    )
  }
  // Bedrock / Vertex / Foundry signal cloud-provider routing in env; treat
  // the flag alone as complete (these paths rely on ambient AWS/GCP creds).
  return true
}

function hasConflictingProviderFlagsForProfile(
  processEnv: NodeJS.ProcessEnv,
  profile: ProviderProfile,
): boolean {
  if (profile.provider === 'anthropic') {
    // User prefers openai over anthropic
    return hasProviderSelectionFlags(processEnv)
  }

  if (hasProviderSelectionFlags(processEnv)) {
    const appliedId = trimOrUndefined(processEnv[PROFILE_ENV_APPLIED_ID])

    // Profile IDs don't match - user explicitly set CLAUDE_CODE_USE_OPENAI
    // while a different profile was managing the env.
    if (appliedId !== profile.id) {
      return true
    }

    // Profile IDs match - check if the critical values (baseUrl, apiKey) are aligned.
    // If only the model drifted (e.g., clobbered by settings merge), re-apply is fine.
    // But if baseUrl itself changed, it's a user override - don't re-apply.
    if (
      processEnv[PROFILE_ENV_APPLIED_FLAG] === '1' &&
      !sameOptionalEnvValue(processEnv.OPENAI_BASE_URL, profile.baseUrl)
    ) {
      return true
    }
  }

  return false
}

function sameOptionalEnvValue(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return trimOrUndefined(left) === trimOrUndefined(right)
}

function isProcessEnvAlignedWithProfile(
  processEnv: NodeJS.ProcessEnv,
  profile: ProviderProfile,
  options?: {
    includeApiKey?: boolean
  },
): boolean {
  const includeApiKey = options?.includeApiKey ?? true

  if (processEnv[PROFILE_ENV_APPLIED_FLAG] !== '1') {
    return false
  }

  if (trimOrUndefined(processEnv[PROFILE_ENV_APPLIED_ID]) !== profile.id) {
    return false
  }

  if (profile.provider === 'anthropic') {
    return (
      !hasProviderSelectionFlags(processEnv) &&
      sameOptionalEnvValue(processEnv.ANTHROPIC_BASE_URL, profile.baseUrl) &&
      sameOptionalEnvValue(processEnv.ANTHROPIC_MODEL, getPrimaryModel(profile.model)) &&
      (!includeApiKey ||
        sameOptionalEnvValue(processEnv.ANTHROPIC_API_KEY, profile.apiKey))
    )
  }

  return (
    processEnv.CLAUDE_CODE_USE_OPENAI !== undefined &&
    sameOptionalEnvValue(processEnv.OPENAI_BASE_URL, profile.baseUrl) &&
    sameOptionalEnvValue(processEnv.OPENAI_MODEL, getPrimaryModel(profile.model)) &&
    sameOptionalEnvValue(processEnv.OPENAI_API_FORMAT, profile.apiFormat) &&
    sameOptionalEnvValue(processEnv.OPENAI_AUTH_HEADER, profile.authHeader) &&
    sameOptionalEnvValue(processEnv.OPENAI_AUTH_SCHEME, profile.authScheme) &&
    sameOptionalEnvValue(processEnv.OPENAI_AUTH_HEADER_VALUE, profile.authHeaderValue) &&
    (!includeApiKey ||
      sameOptionalEnvValue(processEnv.OPENAI_API_KEY, profile.apiKey))
  )
}

export function getActiveProviderProfile(
  config = getGlobalConfig(),
): ProviderProfile | undefined {
  const profiles = getProviderProfiles(config)
  if (profiles.length === 0) {
    return undefined
  }

  const activeId = trimOrUndefined(config.activeProviderProfileId)
  return profiles.find(profile => profile.id === activeId) ?? profiles[0]
}

export function clearProviderProfileEnvFromProcessEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
): void {
  return
  delete processEnv.CLAUDE_CODE_USE_OPENAI

  delete processEnv.OPENAI_BASE_URL
  delete processEnv.OPENAI_API_BASE
  delete processEnv.OPENAI_MODEL
  delete processEnv.OPENAI_API_FORMAT
  delete processEnv.OPENAI_AUTH_HEADER
  delete processEnv.OPENAI_AUTH_SCHEME
  delete processEnv.OPENAI_AUTH_HEADER_VALUE
  // Preserve OPENAI_API_KEY so users can set keys via environment variables
  // while using profile-provided baseUrl/model configurations
  // delete processEnv.OPENAI_API_KEY

  delete processEnv.ANTHROPIC_BASE_URL
  delete processEnv.ANTHROPIC_MODEL
  delete processEnv.ANTHROPIC_API_KEY
  delete processEnv[PROFILE_ENV_APPLIED_FLAG]
  delete processEnv[PROFILE_ENV_APPLIED_ID]
}

export function applyProviderProfileToProcessEnv(profile: ProviderProfile): void {
  // 已注释：切换 provider 时不清除其它 provider 的环境变量
  // clearProviderProfileEnvFromProcessEnv()
  process.env[PROFILE_ENV_APPLIED_FLAG] = '1'
  process.env[PROFILE_ENV_APPLIED_ID] = profile.id

  if (profile.provider === 'anthropic') {
    process.env.ANTHROPIC_MODEL = getPrimaryModel(profile.model)
    process.env.ANTHROPIC_BASE_URL = profile.baseUrl

    if (profile.apiKey) {
      process.env.ANTHROPIC_API_KEY = profile.apiKey
      return
    } else {
      return
      delete process.env.ANTHROPIC_API_KEY
    }

    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.OPENAI_MODEL
    delete process.env.OPENAI_API_FORMAT
    delete process.env.OPENAI_AUTH_HEADER
    delete process.env.OPENAI_AUTH_SCHEME
    delete process.env.OPENAI_AUTH_HEADER_VALUE
    // Preserve OPENAI_API_KEY for cases where profile doesn't set it
    // and user expects env var to be used

    return
  }

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = profile.baseUrl
  process.env.OPENAI_MODEL = getPrimaryModel(profile.model)
  if (profile.apiFormat) {
    process.env.OPENAI_API_FORMAT = profile.apiFormat
  } else {
    delete process.env.OPENAI_API_FORMAT
  }
  if (profile.authHeader) {
    process.env.OPENAI_AUTH_HEADER = profile.authHeader
    process.env.OPENAI_AUTH_SCHEME = profile.authScheme ?? (
      profile.authHeader.toLowerCase() === 'authorization' ? 'bearer' : 'raw'
    )
    if (profile.authHeaderValue) {
      process.env.OPENAI_AUTH_HEADER_VALUE = profile.authHeaderValue
    } else {
      delete process.env.OPENAI_AUTH_HEADER_VALUE
    }
  } else {
    delete process.env.OPENAI_AUTH_HEADER
    delete process.env.OPENAI_AUTH_SCHEME
    delete process.env.OPENAI_AUTH_HEADER_VALUE
  }

  if (profile.apiKey) {
    process.env.OPENAI_API_KEY = profile.apiKey
  }
  // 不要删除 apiKey：如果 profile 没有 apiKey，保留当前环境的 apiKey

  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_API_KEY
  // ANTHROPIC_MODEL is not deleted — it is not used when USE_OPENAI=1
}

export function applyActiveProviderProfileFromConfig(
  config = getGlobalConfig(),
  options?: {
    processEnv?: NodeJS.ProcessEnv
    force?: boolean
  },
): ProviderProfile | undefined {
  const processEnv = options?.processEnv ?? process.env
  const activeProfile = getActiveProviderProfile(config)
  if (!activeProfile) {
    return undefined
  }

  const isCurrentEnvProfileManaged =
    processEnv[PROFILE_ENV_APPLIED_FLAG] === '1' &&
    trimOrUndefined(processEnv[PROFILE_ENV_APPLIED_ID]) === activeProfile.id

  if (!options?.force && (hasCompleteProviderSelection(processEnv) || processEnv[PROFILE_ENV_APPLIED_FLAG] === '1')) {
    // Respect explicit startup provider intent. Auto-heal only when this
    // exact active profile previously applied the current env.
    // NOTE: we gate on hasCompleteProviderSelection (flag + concrete config)
    // rather than hasProviderSelectionFlags alone. A bare CLAUDE_CODE_USE_*=1
    // with no BASE_URL/MODEL is almost always a stale shell export, not
    // intent — respecting it would skip the saved profile and fall through
    // to hardcoded provider defaults, which surfaces as "my saved provider
    // isn't being picked up at startup".
    // If the profile has an apiKey but the current env doesn't, we should still
    // apply the profile's apiKey even if shell/settings has a "complete selection".
    // But if the env already has the apiKey, we skip to preserve it (don't override with empty profile apiKey).
    const profileHasApiKey = Boolean(activeProfile.apiKey)
    const envHasApiKey = Boolean(
      trimOrUndefined(processEnv.OPENAI_API_KEY) ||
        trimOrUndefined(processEnv.ANTHROPIC_API_KEY),
    )
    // Skip profile application only if:
    // - env is not managed by this profile AND
    // - profile doesn't have apiKey that env is missing
    if (
      !isCurrentEnvProfileManaged &&
      !(profileHasApiKey && !envHasApiKey)
    ) {
      return undefined
    }

    if (hasConflictingProviderFlagsForProfile(processEnv, activeProfile)) {
      return undefined
    }

    if (isProcessEnvAlignedWithProfile(processEnv, activeProfile)) {
      return activeProfile
    }
  }

  applyProviderProfileToProcessEnv(activeProfile)
  return activeProfile
}

export function addProviderProfile(
  input: ProviderProfileInput,
  options?: { makeActive?: boolean },
): ProviderProfile | null {
  const profile = toProfile(input)
  if (!profile) {
    return null
  }

  const makeActive = options?.makeActive ?? true

  saveGlobalConfig(current => {
    const currentProfiles = getProviderProfiles(current)
    const nextProfiles = [...currentProfiles, profile]
    const currentActive = trimOrUndefined(current.activeProviderProfileId)
    const nextActiveId =
      makeActive || !currentActive || !nextProfiles.some(p => p.id === currentActive)
        ? profile.id
        : currentActive

    return {
      ...current,
      providerProfiles: nextProfiles,
      activeProviderProfileId: nextActiveId,
    }
  })

  const activeProfile = getActiveProviderProfile()
  if (activeProfile?.id === profile.id) {
    applyProviderProfileToProcessEnv(profile)
    clearActiveOpenAIModelOptionsCache()
  }

  return profile
}

export function updateProviderProfile(
  profileId: string,
  input: ProviderProfileInput,
): ProviderProfile | null {
  const updatedProfile = toProfile(input, profileId)
  if (!updatedProfile) {
    return null
  }

  let wasUpdated = false
  let shouldApply = false

  saveGlobalConfig(current => {
    const currentProfiles = getProviderProfiles(current)
    const profileIndex = currentProfiles.findIndex(
      profile => profile.id === profileId,
    )

    if (profileIndex < 0) {
      return current
    }

    wasUpdated = true

    const nextProfiles = [...currentProfiles]
    nextProfiles[profileIndex] = updatedProfile

    const cacheByProfile = {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
    }
    delete cacheByProfile[profileId]

    const currentActive = trimOrUndefined(current.activeProviderProfileId)
    const nextActiveId =
      currentActive && nextProfiles.some(profile => profile.id === currentActive)
        ? currentActive
        : nextProfiles[0]?.id

    shouldApply = nextActiveId === profileId

    return {
      ...current,
      providerProfiles: nextProfiles,
      activeProviderProfileId: nextActiveId,
      openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
      openaiAdditionalModelOptionsCache: shouldApply
        ? []
        : current.openaiAdditionalModelOptionsCache,
    }
  })

  if (!wasUpdated) {
    return null
  }

  if (shouldApply) {
    applyProviderProfileToProcessEnv(updatedProfile)
  }

  return updatedProfile
}

export function persistActiveProviderProfileModel(
  model: string,
): ProviderProfile | null {
  const nextModel = trimOrUndefined(model)
  if (!nextModel) {
    return null
  }

  const activeProfile = getActiveProviderProfile()
  if (!activeProfile) {
    return null
  }

  // If the model is already part of the profile's model list, don't
  // overwrite the field. This preserves comma-separated model lists like
  // "glm-4.5, glm-4.7". Switching between models in the list is a
  // session-level choice handled by mainLoopModelOverride, not a profile
  // edit — the profile's model list should only change via explicit edit.
  const existingModels = parseModelList(activeProfile.model)
  if (existingModels.includes(nextModel)) {
    return activeProfile
  }

  saveGlobalConfig(current => {
    const currentProfiles = getProviderProfiles(current)
    const profileIndex = currentProfiles.findIndex(
      profile => profile.id === activeProfile.id,
    )

    if (profileIndex < 0) {
      return current
    }

    const currentProfile = currentProfiles[profileIndex]
    if (currentProfile.model === nextModel) {
      return current
    }

    const nextProfiles = [...currentProfiles]
    nextProfiles[profileIndex] = {
      ...currentProfile,
      model: nextModel,
    }

    return {
      ...current,
      providerProfiles: nextProfiles,
    }
  })

  const resolvedProfile = getActiveProviderProfile()
  if (!resolvedProfile || resolvedProfile.id !== activeProfile.id) {
    return null
  }

  if (
    process.env[PROFILE_ENV_APPLIED_FLAG] === '1' &&
    trimOrUndefined(process.env[PROFILE_ENV_APPLIED_ID]) === resolvedProfile.id
  ) {
    applyProviderProfileToProcessEnv(resolvedProfile)
  }

  return resolvedProfile
}

/**
 * Generate model options from a provider profile's model field.
 * Each comma-separated model becomes a separate option in the picker.
 */
export function getProfileModelOptions(profile: ProviderProfile): ModelOption[] {
  const models = parseModelList(profile.model)
  if (models.length === 0) {
    return []
  }

  return models.map(model => ({
    value: model,
    label: model,
    description: `Provider: ${profile.name}`,
  }))
}

function buildOpenAICompatibleStartupEnv(
  activeProfile: ProviderProfile,
): ProfileEnv | null {
  if (isCodexBaseUrl(activeProfile.baseUrl)) {
    return null
  }

  if (activeProfile.apiKey) {
    const strictEnv = buildOpenAIProfileEnv({
      goal: 'balanced',
      model: activeProfile.model,
      baseUrl: activeProfile.baseUrl,
      apiKey: activeProfile.apiKey,
      apiFormat: activeProfile.apiFormat,
      authHeader: activeProfile.authHeader,
      authScheme: activeProfile.authScheme,
      authHeaderValue: activeProfile.authHeaderValue,
      processEnv: {},
    })
    if (strictEnv) {
      return strictEnv
    }
  }

  const env: ProfileEnv = {
    OPENAI_BASE_URL: activeProfile.baseUrl,
    OPENAI_MODEL: getPrimaryModel(activeProfile.model),
  }
  if (activeProfile.apiFormat) {
    env.OPENAI_API_FORMAT = activeProfile.apiFormat
  }
  if (activeProfile.authHeader) {
    env.OPENAI_AUTH_HEADER = activeProfile.authHeader
    env.OPENAI_AUTH_SCHEME = activeProfile.authScheme ?? (
      activeProfile.authHeader.toLowerCase() === 'authorization' ? 'bearer' : 'raw'
    )
    if (activeProfile.authHeaderValue) {
      env.OPENAI_AUTH_HEADER_VALUE = activeProfile.authHeaderValue
    }
  }
  if (activeProfile.apiKey) {
    env.OPENAI_API_KEY = activeProfile.apiKey
  } else {
    delete env.OPENAI_API_KEY
  }
  return env
}

export function setActiveProviderProfile(
  profileId: string,
): ProviderProfile | null {
  const current = getGlobalConfig()
  const profiles = getProviderProfiles(current)
  const activeProfile = profiles.find(profile => profile.id === profileId)

  if (!activeProfile) {
    return null
  }

  const profileModelOptions = getProfileModelOptions(activeProfile)

  saveGlobalConfig(config => ({
    ...config,
    activeProviderProfileId: profileId,
    openaiAdditionalModelOptionsCache: profileModelOptions.length > 0
      ? profileModelOptions
      : getModelCacheByProfile(profileId, config),
    openaiAdditionalModelOptionsCacheByProfile: {
      ...(config.openaiAdditionalModelOptionsCacheByProfile ?? {}),
      [profileId]: profileModelOptions.length > 0
        ? profileModelOptions
        : (config.openaiAdditionalModelOptionsCacheByProfile?.[profileId] ?? []),
    },
  }))

  applyProviderProfileToProcessEnv(activeProfile)

  return activeProfile
}

export function deleteProviderProfile(profileId: string): {
  removed: boolean
  activeProfileId?: string
} {
  let removed = false
  let deletedProfile: ProviderProfile | undefined
  let nextActiveProfile: ProviderProfile | undefined

  saveGlobalConfig(current => {
    const currentProfiles = getProviderProfiles(current)
    const existing = currentProfiles.find(profile => profile.id === profileId)

    if (!existing) {
      return current
    }

    removed = true
    deletedProfile = existing

    const nextProfiles = currentProfiles.filter(profile => profile.id !== profileId)
    const currentActive = trimOrUndefined(current.activeProviderProfileId)
    const activeWasDeleted =
      !currentActive || currentActive === profileId ||
      !nextProfiles.some(profile => profile.id === currentActive)

    const nextActiveId = activeWasDeleted ? nextProfiles[0]?.id : currentActive

    if (nextActiveId) {
      nextActiveProfile =
        nextProfiles.find(profile => profile.id === nextActiveId) ?? nextProfiles[0]
    }

    const cacheByProfile = {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
    }
    delete cacheByProfile[profileId]

    return {
      ...current,
      providerProfiles: nextProfiles,
      activeProviderProfileId: nextActiveId,
      openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
      openaiAdditionalModelOptionsCache: nextActiveId
        ? getModelCacheByProfile(nextActiveId, {
            ...current,
            openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
          })
        : [],
    }
  })

  if (nextActiveProfile) {
    applyProviderProfileToProcessEnv(nextActiveProfile)
  } else if (
    deletedProfile &&
    process.env[PROFILE_ENV_APPLIED_FLAG] === '1' &&
    trimOrUndefined(process.env[PROFILE_ENV_APPLIED_ID]) === deletedProfile.id
  ) {
    // Only clear if the env actually matches what this profile would set.
    // If baseUrl/model don't match, the profile was never actually applied to the env.
    if (
      sameOptionalEnvValue(process.env.OPENAI_BASE_URL, deletedProfile.baseUrl) ||
      sameOptionalEnvValue(process.env.ANTHROPIC_BASE_URL, deletedProfile.baseUrl)
    ) {
      clearProviderProfileEnvFromProcessEnv()
    }
  }

  return {
    removed,
    activeProfileId: nextActiveProfile?.id,
  }
}

export function getActiveOpenAIModelOptionsCache(
  config = getGlobalConfig(),
): ModelOption[] {
  const activeProfile = getActiveProviderProfile(config)

  if (!activeProfile) {
    return config.openaiAdditionalModelOptionsCache ?? []
  }

  const cached = config.openaiAdditionalModelOptionsCacheByProfile?.[
    activeProfile.id
  ]
  if (cached) {
    return cached
  }

  // Backward compatibility for users who have only the legacy single cache.
  if (
    Object.keys(config.openaiAdditionalModelOptionsCacheByProfile ?? {}).length ===
    0
  ) {
    return config.openaiAdditionalModelOptionsCache ?? []
  }

  return []
}

export function setActiveOpenAIModelOptionsCache(options: ModelOption[]): void {
  const activeProfile = getActiveProviderProfile()

  if (!activeProfile) {
    saveGlobalConfig(current => ({
      ...current,
      openaiAdditionalModelOptionsCache: options,
    }))
    return
  }

  saveGlobalConfig(current => ({
    ...current,
    openaiAdditionalModelOptionsCache: options,
    openaiAdditionalModelOptionsCacheByProfile: {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
      [activeProfile.id]: options,
    },
  }))
}

export function clearActiveOpenAIModelOptionsCache(): void {
  const activeProfile = getActiveProviderProfile()

  if (!activeProfile) {
    saveGlobalConfig(current => ({
      ...current,
      openaiAdditionalModelOptionsCache: [],
    }))
    return
  }

  saveGlobalConfig(current => {
    const cacheByProfile = {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
    }
    delete cacheByProfile[activeProfile.id]

    return {
      ...current,
      openaiAdditionalModelOptionsCache: [],
      openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
    }
  })
}
