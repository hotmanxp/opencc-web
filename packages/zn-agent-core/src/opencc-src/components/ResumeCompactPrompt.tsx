import React from 'react'

type Props = {
  tokenCount: number
  model: string
  onDone: (choice: 'yes' | 'no') => void
}

export function ResumeCompactPrompt({ tokenCount, model, onDone }: Props): React.ReactNode | null {
  return null;
}
