import type { ReactNode } from 'react'

export function KeepMounted({
  hidden,
  children,
}: {
  hidden: boolean
  children: ReactNode
}): ReactNode | null {
  return null;
}
