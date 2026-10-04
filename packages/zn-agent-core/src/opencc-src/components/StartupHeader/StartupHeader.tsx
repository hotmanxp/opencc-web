// @ts-nocheck
import * as React from 'react'
import { useMemo } from 'react'
import { getSdkBetas } from '../../bootstrap/state.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { getCwd } from '../../utils/cwd.js'
import { renderModelSetting } from '../../utils/model/model.js'
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
  return null;
})