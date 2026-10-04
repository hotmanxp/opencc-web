import type { ReactNode } from 'react'
import type { EffortLevel } from '../utils/effort.js'

type EffortOption = {
  label: ReactNode
  value: string
  description: string
  isAvailable: boolean
}

type Props = {
  onSelect: (effort: EffortLevel | undefined) => void
  onCancel?: () => void
}

export function EffortPicker({ onSelect, onCancel }: Props) {
  return null;
}

function EffortOptionLabel({ level, text, isCurrent }: { level: EffortLevel | 'auto', text: string, isCurrent: boolean }) {
  return null;
}
