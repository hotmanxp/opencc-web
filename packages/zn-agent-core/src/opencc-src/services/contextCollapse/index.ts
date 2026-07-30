// Stub — contextCollapse not included in source snapshot (feature-gated)
export function isContextCollapseEnabled(): boolean {
  return false
}
export function getContextCollapseState() {
  return null
}
export function projectView<T>(_messages: T[]): T[] {
  return _messages
}
export function getStats(): {
  health: {
    totalSpawns: number
    totalErrors: number
    lastError: string | null
    emptySpawnWarningEmitted: boolean
    totalEmptySpawns: number
  }
  collapsedSpans: number
  collapsedMessages: number
  stagedSpans: number
} {
  return {
    health: {
      totalSpawns: 0,
      totalErrors: 0,
      lastError: null,
      emptySpawnWarningEmitted: false,
      totalEmptySpawns: 0,
    },
    collapsedSpans: 0,
    collapsedMessages: 0,
    stagedSpans: 0,
  }
}
export function subscribe(): () => void {
  return () => {}
}
export async function applyCollapsesIfNeeded(...args: any[]): Promise<any> {
  return args[0]
}
export function isWithheldPromptTooLong(...args: any[]): boolean {
  return false
}
export async function recoverFromOverflow(...args: any[]): Promise<any> {
  return []
}
export function resetContextCollapse(): void {}
export function initContextCollapse(...args: any[]): void {}
