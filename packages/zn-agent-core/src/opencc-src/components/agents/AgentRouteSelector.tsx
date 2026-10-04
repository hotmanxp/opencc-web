import * as React from 'react'
import { useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import {
  CUSTOM_MODEL_VALUE,
  CLEAR_ROUTE_VALUE,
  buildRouteOptions,
  clearAgentRoute,
  currentRouteValue,
  getRouteShadowSource,
  getShadowedModelKeys,
  setAgentRoute,
  shadowRemediation,
  type CurrentAgentRoute,
} from '../../services/api/agentRouteSettings.js'
import type { OptionWithDescription } from '../CustomSelect/select.js'
import { Select } from '../CustomSelect/select.js'
import { getInitialSettings, getSettingsForSource } from '../../utils/settings/settings.js'

type Props = {
  agentType: string
  current: CurrentAgentRoute
  onClose: () => void
}

export function AgentRouteSelector({ agentType, current, onClose }: Props): React.ReactNode | null {
  return null;
}
