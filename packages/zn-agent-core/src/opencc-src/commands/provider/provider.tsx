// @ts-nocheck
import * as React from 'react'

import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import {  } from '../../constants/product.js'
import { BRAND_NAME } from '../../constants.js'
import { type ProviderManagerResult } from '../../components/ProviderManager.js'
import TextInput from '../../components/TextInput.js'
import {
  DEFAULT_OPENAI_BASE_URL,
  isLocalProviderUrl,
  resolveProviderRequest,
} from '../../services/api/providerConfig.js'
import { createProfileFile, loadProfileFile, maskSecretForDisplay, redactSecretValueForDisplay, sanitizeProviderConfigValue, saveProfileFile, type ProfileEnv, type ProfileFile, type ProviderProfile } from '../../utils/providerProfile.js'
import { type RecommendationGoal } from '../../utils/providerRecommendation.js'
import { getLocalOpenAICompatibleProviderLabel } from '../../utils/providerDiscovery.js'

export function buildProviderManagerCompletion(result?: ProviderManagerResult): {
  message: string
  metaMessages?: string[]
} {
  const message =
    result?.message ??
    (result?.action === 'saved'
      ? 'Provider profile updated'
      : 'Provider manager closed')
  const metaMessages =
    result?.action === 'activated' && result.activeProviderName
      ? [
          `<system-reminder>Provider switched mid-session to ${result.activeProviderName}${
            result.activeProviderModel
              ? ` using model ${result.activeProviderModel}`
              : ''
          }. Use this provider/model for subsequent requests unless the user switches again.</system-reminder>`,
        ]
      : undefined

  return { message, metaMessages }
}

function describeOllamaReadinessIssue(
  readiness: OllamaGenerationReadiness,
  options?: {
    baseUrl?: string
    allowManualFallback?: boolean
  },
): string {
  const endpoint = options?.baseUrl ?? 'http://localhost:11434'

  if (readiness.state === 'unreachable') {
    return `Could not reach Ollama at ${endpoint}. Start Ollama first, then run /provider again.`
  }

  if (readiness.state === 'no_models') {
    const manualSuffix = options?.allowManualFallback
      ? ', or enter details manually'
      : ''
    return `Ollama is running, but no installed models were found. Pull a chat model such as qwen2.5-coder:7b or llama3.1:8b first${manualSuffix}.`
  }

  if (readiness.state === 'generation_failed') {
    const modelHint = readiness.probeModel ?? 'the selected model'
    const detailSuffix = readiness.detail
      ? ` Details: ${readiness.detail}.`
      : ''
    const manualSuffix = options?.allowManualFallback
      ? ' You can also enter details manually.'
      : ''
    return `Ollama is reachable and models are installed, but a generation probe failed for ${modelHint}.${detailSuffix} Run "ollama run ${modelHint}" once and retry.${manualSuffix}`
  }

  return ''
}

type ProviderChoice = 'auto' | ProviderProfile | 'codex-oauth' | 'clear'

type Step =
  | { name: 'choose' }
  | { name: 'auto-goal' }
  | { name: 'auto-detect'; goal: RecommendationGoal }
  | { name: 'ollama-detect' }
  | { name: 'openai-key'; defaultModel: string }
  | { name: 'openai-base'; apiKey: string; defaultModel: string }
  | {
      name: 'openai-model'
      apiKey: string
      baseUrl: string | null
      defaultModel: string
    }

type CurrentProviderSummary = {
  providerLabel: string
  modelLabel: string
  endpointLabel: string
  savedProfileLabel: string
}

type SavedProfileSummary = {
  providerLabel: string
  modelLabel: string
  endpointLabel: string
  credentialLabel?: string
}

type TextEntryDialogProps = {
  title: string
  subtitle?: string
  resetStateKey?: string
  description: React.ReactNode
  initialValue: string
  placeholder?: string
  mask?: string
  allowEmpty?: boolean
  validate?: (value: string) => string | null
  onSubmit: (value: string) => void
  onCancel: () => void
}

type ProviderWizardDefaults = {
  openAIModel: string
  openAIBaseUrl: string
}

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}

function getSafeDisplayValue(
  value: string | undefined,
  processEnv: NodeJS.ProcessEnv,
  profileEnv?: ProfileEnv,
  fallback = '(not set)',
): string {
  return (
    redactSecretValueForDisplay(value, processEnv, profileEnv) ?? fallback
  )
}

export function getProviderWizardDefaults(
  processEnv: NodeJS.ProcessEnv = process.env,
): ProviderWizardDefaults {
  const safeOpenAIModel =
    sanitizeProviderConfigValue(processEnv.OPENAI_MODEL, processEnv) ||
    'gpt-4o'
  const safeOpenAIBaseUrl =
    sanitizeProviderConfigValue(processEnv.OPENAI_BASE_URL, processEnv) ||
    DEFAULT_OPENAI_BASE_URL

  return {
    openAIModel: safeOpenAIModel,
    openAIBaseUrl: safeOpenAIBaseUrl,
  }
}

export function buildCurrentProviderSummary(options?: {
  processEnv?: NodeJS.ProcessEnv
  persisted?: ProfileFile | null
}): CurrentProviderSummary {
  const processEnv = options?.processEnv ?? process.env
  const persisted = options?.persisted ?? loadProfileFile()
  const savedProfileLabel = persisted?.profile ?? 'none'

  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_OPENAI)) {
    const request = resolveProviderRequest({
      model: processEnv.OPENAI_MODEL,
      baseUrl: processEnv.OPENAI_BASE_URL,
    })

    let providerLabel = 'OpenAI-compatible'
    if (isLocalProviderUrl(request.baseUrl)) {
      providerLabel = getLocalOpenAICompatibleProviderLabel(request.baseUrl)
    }

    return {
      providerLabel,
      modelLabel: getSafeDisplayValue(request.requestedModel, processEnv),
      endpointLabel: getSafeDisplayValue(request.baseUrl, processEnv),
      savedProfileLabel,
    }
  }

  return {
    providerLabel: 'Anthropic',
    modelLabel: getSafeDisplayValue(
      processEnv.ANTHROPIC_MODEL ??
        processEnv.CLAUDE_MODEL ??
        'claude-sonnet-4-6',
      processEnv,
    ),
    endpointLabel: getSafeDisplayValue(
      processEnv.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
      processEnv,
    ),
    savedProfileLabel,
  }
}

function buildSavedProfileSummary(
  profile: ProviderProfile,
  env: ProfileEnv,
): SavedProfileSummary {
  switch (profile) {
    case 'ollama':
      return {
        providerLabel: 'Ollama',
        modelLabel: getSafeDisplayValue(
          env.OPENAI_MODEL,
          process.env,
          env,
        ),
        endpointLabel: getSafeDisplayValue(
          env.OPENAI_BASE_URL,
          process.env,
          env,
        ),
      }
    case 'openai':
    default: {
      const baseUrl = env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL

      return {
        providerLabel: isLocalProviderUrl(baseUrl)
          ? getLocalOpenAICompatibleProviderLabel(baseUrl)
          : 'OpenAI-compatible',
        modelLabel: getSafeDisplayValue(
          env.OPENAI_MODEL ?? 'gpt-4o',
          process.env,
          env,
        ),
        endpointLabel: getSafeDisplayValue(
          baseUrl,
          process.env,
          env,
        ),
        credentialLabel:
          maskSecretForDisplay(env.OPENAI_API_KEY) !== undefined
            ? 'configured'
            : undefined,
      }
    }
  }
}

export function buildProfileSaveMessage(
  profile: ProviderProfile,
  env: ProfileEnv,
  filePath: string,
): string {
  const summary = buildSavedProfileSummary(profile, env)
  const lines = [
    `Saved ${summary.providerLabel} profile.`,
    `Model: ${summary.modelLabel}`,
    `Endpoint: ${summary.endpointLabel}`,
  ]

  if (summary.credentialLabel) {
    lines.push(`Credentials: ${summary.credentialLabel}`)
  }

  lines.push(`Profile: ${filePath}`)
  lines.push(`Restart ${BRAND_NAME} to use it.`)

  return lines.join('\n')
}

function buildUsageText(): string {
  const summary = buildCurrentProviderSummary()
  return [
    'Usage: /provider',
    '',
    'Guided setup for saved provider profiles.',
    '',
    `Current provider: ${summary.providerLabel}`,
    `Current model: ${summary.modelLabel}`,
    `Current endpoint: ${summary.endpointLabel}`,
    `Saved profile: ${summary.savedProfileLabel}`,
    '',
    `Choose Auto, Ollama, or OpenAI-compatible, then save a profile for the next ${BRAND_NAME} restart.`,
  ].join('\n')
}

function finishProfileSave(
  onDone: LocalJSXCommandOnDone,
  profile: ProviderProfile,
  env: ProfileEnv,
): void {
  try {
    const profileFile = createProfileFile(profile, env)
    const filePath = saveProfileFile(profileFile)
    onDone(buildProfileSaveMessage(profile, env, filePath), {
      display: 'system',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onDone(`Failed to save provider profile: ${message}`, {
      display: 'system',
    })
  }
}

export function TextEntryDialog({
  title,
  subtitle,
  resetStateKey,
  description,
  initialValue,
  placeholder,
  mask,
  allowEmpty = false,
  validate,
  onSubmit,
  onCancel,
}: TextEntryDialogProps): React.ReactNode | null {
  return null;
}

function ProviderChooser({
  onChoose,
  onCancel,
}: {
  onChoose: (value: ProviderChoice) => void
  onCancel: () => void
}): React.ReactNode | null {
  return null;
}

function AutoGoalChooser({
  onChoose,
  onBack,
}: {
  onChoose: (goal: RecommendationGoal) => void
  onBack: () => void
}): React.ReactNode | null {
  return null;
}

function AutoRecommendationStep({
  goal,
  onBack,
  onSave,
  onNeedOpenAI,
  onCancel,
}: {
  goal: RecommendationGoal
  onBack: () => void
  onSave: (profile: ProviderProfile, env: ProfileEnv) => void
  onNeedOpenAI: (defaultModel: string) => void
  onCancel: () => void
}): React.ReactNode | null {
  return null;
}

function OllamaModelStep({
  onSave,
  onBack,
  onCancel,
}: {
  onSave: (profile: ProviderProfile, env: ProfileEnv) => void
  onBack: () => void
  onCancel: () => void
}): React.ReactNode | null {
  return null;
}

export function ProviderWizard({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode | null {
  return null;
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  return Promise.resolve(null);
}
