import figures from 'figures'
import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { ProviderProfile } from '../utils/config.js'
import { hasLocalOllama, listOllamaModels } from '../utils/providerDiscovery.js'
import {
  addProviderProfile,
  deleteProviderProfile,
  getActiveProviderProfile,
  getProviderPresetDefaults,
  getProviderProfiles,
  maybeResetMainLoopModel,
  setActiveProviderProfile,
  type ProviderPreset,
  type ProviderProfileInput,
  updateProviderProfile,
} from '../utils/providerProfiles.js'
import {
  rankOllamaModels,
  recommendOllamaModel,
} from '../utils/providerRecommendation.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { type OptionWithDescription, Select } from './CustomSelect/index.js'
import { Pane } from './design-system/Pane.js'
import TextInput from './TextInput.js'

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

export function ProviderManager({ mode, onDone }: Props): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const setAppState = useSetAppState()
  const [profiles, setProfiles] = React.useState(() => getProviderProfiles())
  const [activeProfileId, setActiveProfileId] = React.useState(
    () => getActiveProviderProfile()?.id,
  )
  const [screen, setScreen] = React.useState<Screen>(
    mode === 'first-run' ? 'select-preset' : 'menu',
  )
  const [editingProfileId, setEditingProfileId] = React.useState<string | null>(null)
  const [draftProvider, setDraftProvider] = React.useState<ProviderProfile['provider']>(
    'openai',
  )
  const [draft, setDraft] = React.useState<ProviderDraft>(() =>
    presetToDraft('ollama'),
  )
  const [formStepIndex, setFormStepIndex] = React.useState(0)
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const [statusMessage, setStatusMessage] = React.useState<string | undefined>()
  const [errorMessage, setErrorMessage] = React.useState<string | undefined>()
  const [ollamaSelection, setOllamaSelection] = React.useState<OllamaSelectionState>({
    state: 'idle',
  })

  const formSteps = React.useMemo(
    () =>
      draftProvider === 'openai'
        ? FORM_STEPS
        : FORM_STEPS.filter(step =>
            step.key !== 'apiFormat' &&
            step.key !== 'authHeader' &&
            step.key !== 'authHeaderValue'
          ),
    [draftProvider],
  )
  const currentStep = formSteps[formStepIndex] ?? formSteps[0] ?? FORM_STEPS[0]
  const currentStepKey = currentStep.key
  const currentValue = draft[currentStepKey]

  function refreshProfiles(): void {
    const nextProfiles = getProviderProfiles()
    setProfiles(nextProfiles)
    setActiveProfileId(getActiveProviderProfile()?.id)
  }

  function clearStartupProviderOverrideFromUserSettings(): string | null {
    const { error } = updateSettingsForSource('userSettings', {
      env: {
        CLAUDE_CODE_USE_OPENAI: undefined as any,
      },
    })
    return error ? error.message : null
  }

  function closeWithCancelled(message: string): void {
    onDone({ action: 'cancelled', message })
  }

  React.useEffect(() => {
    if (screen !== 'select-ollama-model') {
      return
    }

    let cancelled = false
    setOllamaSelection({ state: 'loading' })

    void (async () => {
      const available = await hasLocalOllama(draft.baseUrl)
      if (!available) {
        if (!cancelled) {
          setOllamaSelection({
            state: 'unavailable',
            message:
              '无法连接 Ollama。请先启动 Ollama，或手动输入端点。',
          })
        }
        return
      }

      const models = await listOllamaModels(draft.baseUrl)
      if (models.length === 0) {
        if (!cancelled) {
          setOllamaSelection({
            state: 'unavailable',
            message:
              'Ollama 正在运行，但未找到已安装的模型。请先拉取聊天模型（如 qwen2.5-coder:7b 或 llama3.1:8b），或手动输入详细信息。',
          })
        }
        return
      }

      const ranked = rankOllamaModels(models, 'balanced')
      const recommended = recommendOllamaModel(models, 'balanced')
      if (!cancelled) {
        setOllamaSelection({
          state: 'ready',
          defaultValue: recommended?.name ?? ranked[0]?.name,
          options: ranked.map(model => ({
            label: model.name,
            value: model.name,
            description: model.summary,
          })),
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [draft.baseUrl, screen])

  function startCreateFromPreset(preset: ProviderPreset): void {
    const defaults = getProviderPresetDefaults(preset)
    const nextDraft = {
      name: defaults.name,
      baseUrl: defaults.baseUrl,
      model: defaults.model,
      apiKey: defaults.apiKey ?? '',
      apiFormat: 'chat_completions',
      authHeader: '',
      authHeaderValue: '',
    }
    setEditingProfileId(null)
    setDraftProvider(defaults.provider ?? 'openai')
    setDraft(nextDraft)
    setFormStepIndex(0)
    setCursorOffset(nextDraft.name.length)
    setErrorMessage(undefined)

    if (preset === 'ollama') {
      setOllamaSelection({ state: 'loading' })
      setScreen('select-ollama-model')
      return
    }

    setScreen('form')
  }

  function startEditProfile(profileId: string): void {
    const existing = profiles.find(profile => profile.id === profileId)
    if (!existing) {
      return
    }

    const nextDraft = toDraft(existing)
    setEditingProfileId(profileId)
    setDraftProvider(existing.provider ?? 'openai')
    setDraft(nextDraft)
    setFormStepIndex(0)
    setCursorOffset(nextDraft.name.length)
    setErrorMessage(undefined)
    setScreen('form')
  }

  function persistDraft(nextDraft: ProviderDraft = draft): void {
    const payload: ProviderProfileInput = {
      provider: draftProvider,
      name: nextDraft.name,
      baseUrl: nextDraft.baseUrl,
      model: nextDraft.model,
      apiKey: nextDraft.apiKey,
      apiFormat:
        draftProvider === 'openai' && nextDraft.apiFormat === 'responses'
          ? 'responses'
          : 'chat_completions',
      authHeader:
        draftProvider === 'openai' && nextDraft.authHeader
          ? nextDraft.authHeader
          : undefined,
      authScheme:
        draftProvider === 'openai' && nextDraft.authHeader
          ? (nextDraft.authHeader.toLowerCase() === 'authorization' ? 'bearer' : 'raw')
          : undefined,
      authHeaderValue:
        draftProvider === 'openai' && nextDraft.authHeaderValue
          ? nextDraft.authHeaderValue
          : undefined,
    }

    const saved = editingProfileId
      ? updateProviderProfile(editingProfileId, payload)
      : addProviderProfile(payload, { makeActive: true })

    if (!saved) {
      setErrorMessage('无法保存提供商。请填写所有必填项。')
      return
    }

    const isActiveSavedProfile = getActiveProviderProfile()?.id === saved.id
    const settingsOverrideError = isActiveSavedProfile
      ? clearStartupProviderOverrideFromUserSettings()
      : null

    refreshProfiles()
    const successMessage =
      editingProfileId
        ? `已更新提供商：${saved.name}`
        : `已添加提供商：${saved.name}（现已激活）`
    setStatusMessage(
      settingsOverrideError
        ? `${successMessage}。警告：无法清除启动提供商覆盖（${settingsOverrideError}）。`
        : successMessage,
    )

    if (mode === 'first-run') {
      onDone({
        action: 'saved',
        activeProfileId: saved.id,
        message: `提供商已配置：${saved.name}`,
      })
      return
    }

    setEditingProfileId(null)
    setFormStepIndex(0)
    setErrorMessage(undefined)
    setScreen('menu')
  }

  function renderOllamaSelection(): React.ReactNode {
    if (ollamaSelection.state === 'loading' || ollamaSelection.state === 'idle') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            正在检查 Ollama
          </Text>
          <Text dimColor>正在查找已安装的 Ollama 模型...</Text>
        </Box>
      )
    }

    if (ollamaSelection.state === 'unavailable') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            Ollama 设置
          </Text>
          <Text dimColor>{ollamaSelection.message}</Text>
          <Select
            options={[
              {
                value: 'manual',
                label: '手动输入',
                description: '自行填写基础 URL 和模型',
              },
              {
                value: 'back',
                label: '返回',
                description: '选择其他提供商预设',
              },
            ]}
            onChange={value => {
              if (value === 'manual') {
                setFormStepIndex(0)
                setCursorOffset(draft.name.length)
                setScreen('form')
                return
              }
              setScreen('select-preset')
            }}
            onCancel={() => setScreen('select-preset')}
            visibleOptionCount={2}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          选择 Ollama 模型
        </Text>
        <Text dimColor>
          选择一个已安装的 Ollama 模型，保存到本地提供商配置文件中。
        </Text>
        <Select
          options={ollamaSelection.options}
          defaultValue={ollamaSelection.defaultValue}
          defaultFocusValue={ollamaSelection.defaultValue}
          inlineDescriptions
          visibleOptionCount={Math.min(8, ollamaSelection.options.length)}
          onChange={value => {
            const nextDraft = {
              ...draft,
              model: value,
            }
            setDraft(nextDraft)
            persistDraft(nextDraft)
          }}
          onCancel={() => setScreen('select-preset')}
        />
      </Box>
    )
  }

  function handleFormSubmit(value: string): void {
    const trimmed = value.trim()

    if (!currentStep.optional && trimmed.length === 0) {
      setErrorMessage(`${currentStep.label} 是必填项。`)
      return
    }

    const nextDraft = {
      ...draft,
      [currentStepKey]: trimmed,
    }

    setDraft(nextDraft)
    setErrorMessage(undefined)

    if (formStepIndex < formSteps.length - 1) {
      const nextIndex = formStepIndex + 1
      const nextKey = formSteps[nextIndex]?.key ?? 'name'
      setFormStepIndex(nextIndex)
      setCursorOffset(nextDraft[nextKey].length)
      return
    }

    persistDraft(nextDraft)
  }

  function handleBackFromForm(): void {
    setErrorMessage(undefined)

    if (formStepIndex > 0) {
      const nextIndex = formStepIndex - 1
      const nextKey = formSteps[nextIndex]?.key ?? 'name'
      setFormStepIndex(nextIndex)
      setCursorOffset(draft[nextKey].length)
      return
    }

    if (mode === 'first-run') {
      setScreen('select-preset')
      return
    }

    setScreen('menu')
  }

  useKeybinding('confirm:no', handleBackFromForm, {
    context: 'Settings',
    isActive: screen === 'form',
  })

  function renderPresetSelection(): React.ReactNode {
    const options = [
      {
        value: 'anthropic',
        label: 'Anthropic',
        description: '原生 Claude API（x-api-key 认证）',
      },
      {
        value: 'ollama',
        label: 'Ollama',
        description: '本地或远程 Ollama 端点',
      },
      {
        value: 'openai',
        label: 'OpenAI',
        description: '使用 API 密钥的 OpenAI API',
      },
      {
        value: 'custom',
        label: '自定义',
        description: '任意 OpenAI 兼容提供商',
      },
      ...(mode === 'first-run'
        ? [
            {
              value: 'skip',
              label: '暂时跳过',
              description: '使用当前默认配置继续',
            },
          ]
        : []),
    ]

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {mode === 'first-run' ? '设置提供商' : '选择提供商预设'}
        </Text>
        <Text dimColor>
          选择一个预设，然后确认基础 URL、模型和 API 密钥。
        </Text>
        <Select
          options={options}
          onChange={value => {
            if (value === 'skip') {
              closeWithCancelled('提供商设置已跳过')
              return
            }
            startCreateFromPreset(value as ProviderPreset)
          }}
          onCancel={() => {
            if (mode === 'first-run') {
              closeWithCancelled('提供商设置已跳过')
              return
            }
            setScreen('menu')
          }}
          visibleOptionCount={Math.min(12, options.length)}
        />
      </Box>
    )
  }

  function renderForm(): React.ReactNode {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {editingProfileId ? '编辑提供商配置文件' : '创建提供商配置文件'}
        </Text>
        <Text dimColor>{currentStep.helpText}</Text>
        <Text dimColor>
          提供商类型：{' '}
          {draftProvider === 'anthropic'
            ? 'Anthropic 原生 API'
            : 'OpenAI 兼容 API'}
        </Text>
        <Text dimColor>
          第 {formStepIndex + 1} 步，共 {formSteps.length} 步：{currentStep.label}
        </Text>
        {currentStepKey === 'apiFormat' ? (
          <Select
            options={[
              {
                value: 'chat_completions',
                label: 'Chat Completions',
                description: 'Use /chat/completions for broad OpenAI-compatible support',
              },
              {
                value: 'responses',
                label: 'Responses',
                description: 'Use /responses for providers that support the Responses API',
              },
            ]}
            defaultValue={
              currentValue === 'responses' ? 'responses' : 'chat_completions'
            }
            onChange={handleFormSubmit}
            focus={true}
            showCursor={true}
            placeholder={`${currentStep.placeholder}${figures.ellipsis}`}
            columns={80}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        ) : (
          <Box flexDirection="row" gap={1}>
            <Text>{figures.pointer}</Text>
            <TextInput
              value={currentValue}
              onChange={value =>
                setDraft(prev => ({
                  ...prev,
                  [currentStepKey]: value,
                }))
              }
              onSubmit={handleFormSubmit}
              focus={true}
              showCursor={true}
              placeholder={`${currentStep.placeholder}${figures.ellipsis}`}
              mask={
                currentStepKey === 'apiKey' ||
                currentStepKey === 'authHeaderValue'
                  ? '*'
                  : undefined
              }
              columns={80}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
            />
          </Box>
        )}
        {errorMessage && <Text color="error">{errorMessage}</Text>}
        <Text dimColor>
          按 Enter 继续。按 Esc 返回。
        </Text>
      </Box>
    )
  }

  function renderMenu(): React.ReactNode {
    const hasProfiles = profiles.length > 0
    const hasSelectableProviders = hasProfiles

    const options = [
      {
        value: 'add',
        label: '添加提供商',
        description: '创建新的提供商配置文件',
      },
      {
        value: 'activate',
        label: '设置激活提供商',
        description: '切换激活的提供商配置文件',
        disabled: !hasSelectableProviders,
      },
      {
        value: 'edit',
        label: '编辑提供商',
        description: '更新 URL、模型或密钥',
        disabled: !hasProfiles,
      },
      {
        value: 'delete',
        label: '删除提供商',
        description: '移除提供商配置文件',
        disabled: !hasSelectableProviders,
      },
      {
        value: 'done',
        label: '完成',
        description: '返回聊天',
      },
    ]

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          提供商管理器
        </Text>
        <Text dimColor>
          激活配置文件控制此会话使用的基础 URL、模型和 API 密钥。
        </Text>
        {statusMessage && <Text>{statusMessage}</Text>}
        <Box flexDirection="column">
          {profiles.length === 0 ? (
            <Text dimColor>尚未配置提供商配置文件。</Text>
          ) : (
            <>
              {profiles.map(profile => (
                <Text key={profile.id} dimColor>
                  - {profile.name}: {profileSummary(profile, profile.id === activeProfileId)}
                </Text>
              ))}
            </>
          )}
        </Box>
        <Select
          options={options}
          onChange={value => {
            setErrorMessage(undefined)
            switch (value) {
              case 'add':
                setScreen('select-preset')
                break
              case 'activate':
                if (hasSelectableProviders) {
                  setScreen('select-active')
                }
                break
              case 'edit':
                if (profiles.length > 0) {
                  setScreen('select-edit')
                }
                break
              case 'delete':
                if (hasSelectableProviders) {
                  setScreen('select-delete')
                }
                break
              default:
                closeWithCancelled('提供商管理器已关闭')
                break
            }
          }}
          onCancel={() => closeWithCancelled('Provider manager closed')}
          visibleOptionCount={options.length}
        />
      </Box>
    )
  }

  function renderProfileSelection(
    title: string,
    emptyMessage: string,
    onSelect: (profileId: string) => void,
  ): React.ReactNode {
    const selectOptions = profiles.map(profile => ({
      value: profile.id,
      label:
        profile.id === activeProfileId
          ? `${profile.name}（已激活）`
          : profile.name,
      description: `${profile.provider === 'anthropic' ? 'anthropic' : 'openai-compatible'} · ${profile.baseUrl} · ${profile.model}`,
    }))

    if (selectOptions.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            {title}
          </Text>
          <Text dimColor>{emptyMessage}</Text>
          <Select
            options={[
              {
                value: 'back',
                label: '返回',
                description: '返回提供商管理器',
              },
            ]}
            onChange={() => setScreen('menu')}
            onCancel={() => setScreen('menu')}
            visibleOptionCount={1}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {title}
        </Text>
        <Select
          options={selectOptions}
          onChange={onSelect}
          onCancel={() => setScreen('menu')}
          visibleOptionCount={Math.min(10, Math.max(2, selectOptions.length))}
        />
      </Box>
    )
  }

  let content: React.ReactNode

    switch (screen) {
      case 'select-preset':
        content = renderPresetSelection()
        break
      case 'select-ollama-model':
        content = renderOllamaSelection()
        break
      case 'form':
        content = renderForm()
        break
    case 'select-active':
      content = renderProfileSelection(
        '设置激活提供商',
        '没有可用的提供商。请先添加一个。',
        profileId => {
          const active = setActiveProviderProfile(profileId)
          if (!active) {
            setErrorMessage('无法更改激活提供商。')
            setScreen('menu')
            return
          }
          const settingsOverrideError =
            clearStartupProviderOverrideFromUserSettings()
          refreshProfiles()

          const decision = maybeResetMainLoopModel(active, mainLoopModel)
          const nextModel = decision.newModel
          if (decision.reset && nextModel) {
            setAppState(prev => ({
              ...prev,
              mainLoopModel: nextModel,
              mainLoopModelForSession: null,
            }))
          }

          const providerMessage =
            settingsOverrideError
              ? `激活提供商：${active.name}。警告：无法清除启动提供商覆盖（${settingsOverrideError}）。`
              : `激活提供商：${active.name}`
          const modelSuffix =
            decision.reset && nextModel
              ? ` · Model reset to ${nextModel}`
              : ''
          setStatusMessage(`${providerMessage}${modelSuffix}`)
          setScreen('menu')
        },
      )
      break
    case 'select-edit':
      content = renderProfileSelection(
        '编辑提供商',
        '没有可用的提供商。请先添加一个。',
        profileId => {
          startEditProfile(profileId)
        },
      )
      break
    case 'select-delete':
      content = renderProfileSelection(
        '删除提供商',
        '没有可用的提供商。请先添加一个。',
        profileId => {
          const result = deleteProviderProfile(profileId)
          if (!result.removed) {
            setErrorMessage('无法删除提供商。')
          } else {
            const settingsOverrideError = result.activeProfileId
              ? clearStartupProviderOverrideFromUserSettings()
              : null
            refreshProfiles()
            setStatusMessage(
              settingsOverrideError
                ? `提供商已删除。警告：无法清除启动提供商覆盖（${settingsOverrideError}）。`
                : '提供商已删除',
            )
          }
          setScreen('menu')
        },
      )
      break
    case 'menu':
    default:
      content = renderMenu()
      break
  }

  return <Pane color="permission">{content}</Pane>
}
