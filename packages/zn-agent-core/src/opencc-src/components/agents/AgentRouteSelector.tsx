import * as React from 'react'
import { useRef, useState } from 'react'
import { type CurrentAgentRoute } from '../../services/api/agentRouteSettings.js'

type Props = {
  agentType: string
  current: CurrentAgentRoute
  onClose: () => void
}

export function AgentRouteSelector({ agentType, current, onClose }: Props): React.ReactNode | null {
  return null;
}
