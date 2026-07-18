import type { ReactNode } from "react"

export type ToolRenderer = {
  preview(input: Record<string, unknown>): string
  displayName?(input: Record<string, unknown>): string
  renderInput?(input: Record<string, unknown>): ReactNode
  renderOutput?(output: unknown, isError: boolean): ReactNode
}
