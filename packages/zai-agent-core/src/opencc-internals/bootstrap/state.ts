// @ts-nocheck — zai-local stub for upstream opencc's bootstrap/state.ts.
// Upstream is 1865 lines and pulls in src/utils/crypto, src/utils/settings/*,
// src/tools/AgentTool/agentColorManager.js, ReplayIndexBuilder — all
// deliberately excluded from the opencc-internals cherry-pick mirror (see
// packages/zai-agent-core/scripts/sync-from-opencc.ts: 'bootstrap/' in
// hard-exclude). This stub exports the 18 symbols that 48 @ts-nocheck
// callers in this mirror actually import. If a future task needs richer
// behaviour (session ALS, telemetry counters, etc.), extend THIS file
// rather than pulling upstream. Keep in sync with HARD_EXCLUDE_FILES.

import { cwd } from 'process'

// Session id — empty string preserves type, callers handle "" as "unset".
export function getSessionId(): string {
  return ''
}

export function setSessionId(_id: string): void {
  // no-op
}

// CWD — process.cwd() matches cwd.ts's process.env[ZAI_CWD] fallback.
export function getOriginalCwd(): string {
  return process.cwd()
}

export function setOriginalCwd(_cwd: string): void {
  // no-op
}

export function getProjectRoot(): string {
  return process.cwd()
}

export function setProjectRoot(_root: string): void {
  // no-op
}

// Interactive / TTY flags — zai's web/server context is non-interactive by default.
export function getIsNonInteractiveSession(): boolean {
  return true
}

export function setIsNonInteractiveSession(_value: boolean): void {
  // no-op
}

// Model overrides — empty string means "no override".
export function getInitialMainLoopModel(): string {
  return ''
}

export function getMainLoopModelOverride(): string {
  return ''
}

export function setMainLoopModelOverride(_model: string): void {
  // no-op
}

// SDK init state — empty objects, no reset behaviour.
export function getSdkBetas(): readonly string[] {
  return []
}

export function resetSdkInitState(): void {
  // no-op
}

// Hooks / skills — empty arrays; zai has its own plugin runtime.
export function getRegisteredHooks(): unknown[] {
  return []
}

export function addInvokedSkill(_skillName: string): void {
  // no-op
}

export function getInvokedSkillsForAgent(_agentType: string): string[] {
  return []
}

// Counters / strict-mode toggles — safe defaults.
export function getLocCounter(): number {
  return 0
}

export function getStrictToolResultPairing(): boolean {
  return false
}

export function setStrictToolResultPairing(_value: boolean): void {
  // no-op
}

// Session trust / prompt id — empty defaults.
export function getSessionTrustAccepted(): boolean {
  return false
}

export function setSessionTrustAccepted(_value: boolean): void {
  // no-op
}

export function getPromptId(): string {
  return ''
}

export function setPromptId(_id: string): void {
  // no-op
}

// Telemetry / compaction markers — no-op shims.
export function markPostCompaction(): void {
  // no-op
}

export function getAdditionalDirectoriesForClaudeMd(): string[] {
  return []
}

export function setHasUnknownModelCost(_value: boolean): void {
  // no-op
}
