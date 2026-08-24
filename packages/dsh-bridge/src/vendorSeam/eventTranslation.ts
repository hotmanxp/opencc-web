import type { SubagentRunInfo, SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { SubagentContentBlock } from '../subagent/contentBlock.js'

/**
 * vendor 原生事件 → zai SSE 事件翻译层。
 *
 * deprecation shim:`emitLegacyShim` 同步发旧 `subagent.changed` 事件,
 * 让旧 UI 在迁移期仍能工作。运行期保留,2026-09-30 通过
 * feature flag `agent.subagent.eventV2.enabled = false` 关闭。
 */

export function translateSubagentStart(
  sessionId: string,
  info: SubagentRunInfo & { parentSessionId?: string },
): Record<string, unknown> {
  return {
    type: 'subagent.start',
    ts: Date.now(),
    sessionId,
    runId: info.runId,
    provider: info.provider,
    id: info.id,
    local: info.local,
    ...(info.parentSessionId !== undefined ? { parentSessionId: info.parentSessionId } : {}),
  }
}

const STOP_REASON_TO_LEGACY_STATUS: Record<string, string> = {
  completed: 'done',
  aborted: 'cancelled',
  error: 'failed',
  'max-tokens': 'failed',
  refusal: 'failed',
}

export function translateSubagentEnd(
  sessionId: string,
  info: SubagentRunEndInfo,
): Record<string, unknown> {
  return {
    type: 'subagent.end',
    ts: Date.now(),
    sessionId,
    runId: info.runId,
    provider: info.provider,
    id: info.id,
    local: info.local,
    stopReason: info.stopReason,
    ...(info.lastAssistantMessage !== undefined ? { lastAssistantMessage: info.lastAssistantMessage as SubagentContentBlock[] } : {}),
  }
}

export function translateSubagentDescriptor(
  sessionId: string,
  runId: string,
  info: {
    version: 2
    mode: 'one-shot' | 'continuable'
    provider: string
    label?: string
    persona?: string
    toolFilter?: string[]
    agentProvider?: string
    agentModel?: string
  },
): Record<string, unknown> {
  return {
    type: 'subagent.descriptor',
    ts: Date.now(),
    sessionId,
    runId,
    version: info.version,
    mode: info.mode,
    provider: info.provider,
    ...(info.label !== undefined ? { label: info.label } : {}),
    ...(info.persona !== undefined ? { persona: info.persona } : {}),
    ...(info.toolFilter !== undefined ? { toolFilter: info.toolFilter } : {}),
    ...(info.agentProvider !== undefined ? { agentProvider: info.agentProvider } : {}),
    ...(info.agentModel !== undefined ? { agentModel: info.agentModel } : {}),
  }
}

export function translateSubagentState(
  sessionId: string,
  runId: string,
  state: 'running' | 'waiting' | 'settled',
): Record<string, unknown> {
  return { type: 'subagent.state', ts: Date.now(), sessionId, runId, state }
}

export function translateSubagentMessage(
  sessionId: string,
  runId: string,
  blocks: SubagentContentBlock[],
): Record<string, unknown> {
  return { type: 'subagent.message', ts: Date.now(), sessionId, runId, blocks }
}

/**
 * deprecation shim:把新事件翻译成旧 `subagent.changed` 同步发到 eventBus。
 * UI 完全迁移后此函数删除。
 */
export function emitLegacyShim(
  eventBus: { emit: (e: unknown) => void },
  newEvent: Record<string, unknown>,
): void {
  if (!process.env.ZAI_SUBAGENT_EVENT_V2_ONLY) {
    console.warn(
      '[deprecation] subagent.changed will be removed after 2026-09-30; migrate to subagent.start/subagent.end',
    )
  }
  let legacy: Record<string, unknown> | null = null
  if (newEvent.type === 'subagent.start') {
    legacy = {
      type: 'subagent.changed',
      ts: newEvent.ts,
      sessionId: newEvent.sessionId,
      taskId: newEvent.runId,
      description: '',
      status: 'running',
      action: 'start',
    }
  } else if (newEvent.type === 'subagent.end') {
    legacy = {
      type: 'subagent.changed',
      ts: newEvent.ts,
      sessionId: newEvent.sessionId,
      taskId: newEvent.runId,
      description: '',
      status: STOP_REASON_TO_LEGACY_STATUS[newEvent.stopReason as string] ?? 'failed',
      action: 'finish',
    }
  } else if (newEvent.type === 'subagent.error') {
    legacy = {
      type: 'subagent.changed',
      ts: newEvent.ts,
      sessionId: newEvent.sessionId,
      taskId: newEvent.runId,
      description: '',
      status: 'failed',
      error: newEvent.message,
      action: 'finish',
    }
  }
  if (legacy) eventBus.emit(legacy)
}
