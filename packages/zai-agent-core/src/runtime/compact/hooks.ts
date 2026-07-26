/**
 * pre/post compact hook 接口 — 阶段 2 no-op。
 *
 * spec §4.3:zai 暂无 user-defined hooks,保留接口为后续接入
 * zai-plugin / zai-skill 留口。
 */

import type { TranscriptMessage } from '../../transcript/types.js'

export type CompactHookTrigger = 'auto' | 'manual'

export type PreCompactHookInput = {
  trigger: CompactHookTrigger
  customInstructions: string | null
}

export type PostCompactHookInput = {
  trigger: CompactHookTrigger
  summary: string
  messagesToKeep: TranscriptMessage[]
}

export const HOOK_TIMEOUT_MS = 5_000

export async function executePreCompactHooks(
  _input: PreCompactHookInput,
  _signal: AbortSignal,
): Promise<{ newCustomInstructions?: string; userDisplayMessage?: string }> {
  return {}
}

export async function executePostCompactHooks(
  _input: PostCompactHookInput,
  _signal: AbortSignal,
): Promise<TranscriptMessage[]> {
  return []
}
