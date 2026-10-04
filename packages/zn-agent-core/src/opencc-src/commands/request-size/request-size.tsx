import * as React from 'react'
import { Pane } from '../../components/design-system/Pane.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  createRequestSizeReport,
  formatRequestSizeReport,
} from '../../utils/requestSizeBreakdown.js'
import { collectContextData } from '../context/context-noninteractive.js'

type RequestSizeReportViewProps = {
  reportText: string
  onClose: () => void
}

export function RequestSizeReportView({
  reportText,
  onClose,
}: RequestSizeReportViewProps): React.ReactNode | null {
  return null;
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  return Promise.resolve(null);
}
