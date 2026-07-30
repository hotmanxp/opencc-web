// @ts-nocheck
import { Box, Text } from '../../ink.js'
import * as React from 'react'
import { useMemo } from 'react'
import { getSdkBetas } from '../../bootstrap/state.js'
import { useAppState } from '../../state/AppState.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { getCwd } from '../../utils/cwd.js'
import { getEffortSuffix } from '../../utils/effort.js'
import { renderModelSetting } from '../../utils/model/model.js'
import { expandTilde, truncatePath } from './StartupHeader.pure.js'
import { ClaudeMascot } from './ClaudeMascot.js'
import { formatContextWindow } from './StartupHeader.contextWindow.js'

function safeGetCwd(): string {
  try {
    return getCwd()
  } catch {
    return process.cwd()
  }
}

function safeRenderModel(name: string): string {
  try {
    return renderModelSetting(name)
  } catch {
    return name
  }
}

function safeContextWindowDisplay(name: string): string {
  try {
    const tokens = getContextWindowForModel(name, getSdkBetas())
    return ` (${formatContextWindow(tokens)})`
  } catch {
    return ''
  }
}

export const StartupHeader: React.FC = React.memo(function StartupHeader() {
  const model = useMainLoopModel()
  const effortValue = useAppState(s => s.effortValue)
  const { columns } = useTerminalSize()
  const cwd = useMemo(() => safeGetCwd(), [])
  const expanded = useMemo(() => expandTilde(cwd), [cwd])
  const dirMax = Math.max(10, columns - 30)
  const dir = useMemo(() => truncatePath(expanded, dirMax), [expanded, dirMax])
  const modelDisplay = model ? safeRenderModel(model) : '(no model)'
  const contextWindowDisplay = model ? safeContextWindowDisplay(model) : ''
  const effortSuffix = model ? getEffortSuffix(model, effortValue) : ''
  const version = MACRO.DISPLAY_VERSION ?? MACRO.VERSION ?? 'unknown'

  return (
    <Box alignSelf="flex-start" flexDirection="row" gap={2}>
      <ClaudeMascot />
      <Box flexDirection="column">
        <Text>
          <Text bold>OpenCC</Text> <Text dimColor>v{version}</Text>
        </Text>
        <Text dimColor>
          {modelDisplay}{contextWindowDisplay}{effortSuffix}
        </Text>
        <Text dimColor>{dir}</Text>
      </Box>
    </Box>
  )
})