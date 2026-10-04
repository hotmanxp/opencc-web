import * as React from 'react'
import type { ProviderProfile } from '../utils/config.js'
import { getProviderPresetDefaults, type ProviderPreset } from '../utils/providerProfiles.js'
import { type OptionWithDescription } from './CustomSelect/index.js'

export type ProviderManagerResult = {
  action: 'saved' | 'cancelled' | 'activated'
  activeProfileId?: string
  activeProviderName?: string
  activeProviderModel?: string
  message?: string
}

type Props = {
  mode: 'first-run' | 'manage'
  onDone: (result?: ProviderManagerResult) => void
}

type Screen =
  | 'menu'
  | 'select-preset'
  | 'select-ollama-model'
  | 'form'
  | 'select-active'
  | 'select-edit'
  | 'select-delete'

type DraftField =
  | 'name'
  | 'baseUrl'
  | 'model'
  | 'apiKey'
  | 'apiFormat'
  | 'authHeader'
  | 'authHeaderValue'

type ProviderDraft = Record<DraftField, string>

type OllamaSelectionState =
  | { state: 'idle' }
  | { state: 'loading' }
  | {
      state: 'ready'
      options: OptionWithDescription<string>[]
      defaultValue?: string
    }
  | { state: 'unavailable'; message: string }

const FORM_STEPS: Array<{
  key: DraftField
  label: string
  placeholder: string
  helpText: string
  optional?: boolean
}> = [
  {
    key: 'name',
    label: '提供商名称',
    placeholder: '例如：Ollama Home, OpenAI Work',
    helpText: '在 /provider 和启动设置中显示的简短标签。',
  },
  {
    key: 'baseUrl',
    label: '基础 URL',
    placeholder: '例如：http://localhost:11434/v1',
    helpText: '此提供商配置文件的 API 基础 URL。',
  },
  {
    key: 'model',
    label: '默认模型',
    placeholder: '例如：llama3.1:8b',
    helpText: '此提供商处于激活状态时使用的模型名称。',
  },
  {
    key: 'apiFormat',
    label: 'API 模式',
    placeholder: 'chat_completions',
    helpText: '为此提供商选择 OpenAI 兼容的 API 接口。',
    optional: true,
  },
  {
    key: 'authHeader',
    label: '认证请求头',
    placeholder: '例如：api-key 或 X-API-Key',
    helpText: '可选。自定义提供商密钥使用的请求头名称。',
    optional: true,
  },
  {
    key: 'authHeaderValue',
    label: '认证请求头值',
    placeholder: '留空则使用 API 密钥值',
    helpText: '可选。自定义认证请求头中发送的值。',
    optional: true,
  },
  {
    key: 'apiKey',
    label: 'API 密钥',
    placeholder: '如果提供商不需要密钥则留空',
    helpText: '可选。留空按 Enter 跳过。',
    optional: true,
  },
]

function toDraft(profile: ProviderProfile): ProviderDraft {
  return {
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: profile.apiKey ?? '',
    apiFormat: profile.apiFormat ?? 'chat_completions',
    authHeader: profile.authHeader ?? '',
    authHeaderValue: profile.authHeaderValue ?? '',
  }
}

function presetToDraft(preset: ProviderPreset): ProviderDraft {
  const defaults = getProviderPresetDefaults(preset)
  return {
    name: defaults.name,
    baseUrl: defaults.baseUrl,
    model: defaults.model,
    apiKey: defaults.apiKey ?? '',
    apiFormat: 'chat_completions',
    authHeader: '',
    authHeaderValue: '',
  }
}

function profileSummary(profile: ProviderProfile, isActive: boolean): string {
  const activeSuffix = isActive ? '（已激活）' : ''
  const keyInfo = profile.apiKey ? '密钥已设置' : '无密钥'
  const providerKind =
    profile.provider === 'anthropic' ? 'anthropic' : 'openai-compatible'
  return `${providerKind} · ${profile.baseUrl} · ${profile.model} · ${keyInfo}${activeSuffix}`
}

export function ProviderManager({ mode, onDone }: Props): React.ReactNode | null {
  return null;
}
