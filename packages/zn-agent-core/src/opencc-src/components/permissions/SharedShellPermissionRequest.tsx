// @ts-nocheck
import React, { useCallback, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { OptionWithDescription } from '../CustomSelect/select.js'
import { Select } from '../CustomSelect/select.js'
import { type UnaryEvent, usePermissionRequestLogging } from './hooks.js'
import { PermissionDecisionDebugInfo } from './PermissionDecisionDebugInfo.js'
import { PermissionExplainerContent } from './PermissionExplanation.js'
import { PermissionScaffold } from './PermissionScaffold.js'
import type { PermissionRequestProps, ToolUseConfirm } from './PermissionRequest.js'

type ExplainerState = {
  visible: boolean
  enabled: boolean
  promise: React.ComponentProps<typeof PermissionExplainerContent>['promise']
}

const DEFAULT_UNARY_EVENT: UnaryEvent = {
  completion_type: 'tool_use_single',
  language_name: 'none',
}

type SharedShellPermissionRequestProps<T extends string> = Pick<
  PermissionRequestProps,
  'toolUseContext' | 'workerBadge'
> & {
  toolUseConfirm: ToolUseConfirm
  title: string
  subtitle?: React.ReactNode
  toolName: string
  message: React.ReactNode
  description?: string
  explainerState: ExplainerState
  destructiveWarning?: string | null
  question?: string
  options: OptionWithDescription<T>[]
  onSelect: (value: T) => void
  onCancel: () => void
  onFocus: (value: T) => void
  onInputModeToggle: (value: T) => void
  focusedOption: string
  yesInputMode: boolean
  noInputMode: boolean
  isContentDimmed?: boolean
  isSelectDisabled?: boolean
}

export function SharedShellPermissionRequest<T extends string>({
  toolUseConfirm,
  toolUseContext,
  workerBadge,
  title,
  subtitle,
  toolName,
  message,
  description,
  explainerState,
  destructiveWarning,
  question = 'Do you want to proceed?',
  options,
  onSelect,
  onCancel,
  onFocus,
  onInputModeToggle,
  focusedOption,
  yesInputMode,
  noInputMode,
  isContentDimmed = false,
  isSelectDisabled = false,
}: SharedShellPermissionRequestProps<T>) {
  return null;
}
