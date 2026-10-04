import React from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
import { ProgressBar } from './design-system/ProgressBar.js'
import { getContextWindowForModel } from '../utils/context.js'
import { getEffectiveContextWindowSize } from '../services/compact/autoCompact.js'
import { getSdkBetas } from '../bootstrap/state.js'

type Props = {
  tokenCount: number
  model: string
  onDone: (choice: 'yes' | 'no') => void
}

export function ResumeCompactPrompt({ tokenCount, model, onDone }: Props): React.ReactNode | null {
  return null;
}
