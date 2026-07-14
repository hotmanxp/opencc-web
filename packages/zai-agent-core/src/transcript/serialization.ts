import type { TranscriptFile, TranscriptMessage, TranscriptMeta } from './types.js'
import { LegacyTranscriptError } from './types.js'

export function serializeMessage(msg: TranscriptMessage): string {
  return JSON.stringify(msg)
}

export function deserializeMessage(raw: string): TranscriptMessage {
  return JSON.parse(raw) as TranscriptMessage
}

export function serializeFile(file: TranscriptFile): string {
  return JSON.stringify(file, null, 2)
}

export function deserializeFile(raw: string): TranscriptFile {
  const parsed = JSON.parse(raw) as { version: number; [k: string]: unknown }
  if (parsed.version === 1) {
    throw new LegacyTranscriptError('version=1 — tool_use/tool_result not preserved')
  }
  if (parsed.version !== 2) {
    throw new Error(`Unsupported transcript version: ${parsed.version}`)
  }
  return parsed as unknown as TranscriptFile
}

export function extractMeta(file: TranscriptFile): TranscriptMeta {
  return {
    transcriptId: file.transcriptId,
    version: 2,
    cwd: file.meta.cwd,
    model: file.meta.model,
    createdAt: file.meta.createdAt,
    updatedAt: file.meta.updatedAt,
    title: file.meta.title,
    tags: file.meta.tags,
    messageCount: file.messages.length,
    parentSessionId: file.meta.parentSessionId,
    subagentType: file.meta.subagentType,
  }
}
