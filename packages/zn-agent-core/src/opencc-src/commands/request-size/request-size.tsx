import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'

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
