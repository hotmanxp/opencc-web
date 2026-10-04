import React from 'react'
import { getOriginalCwd } from '../../../bootstrap/state.js'
import { Box, Text } from '../../../ink.js'
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { usePermissionRequestLogging } from '../hooks.js'
import { PermissionDialog } from '../PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from '../PermissionPrompt.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { logUnaryPermissionEvent } from '../utils.js'

type OptionValue = 'yes' | 'yes-dont-ask-again' | 'no'

export function MonitorPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps) {
  return null;
}
