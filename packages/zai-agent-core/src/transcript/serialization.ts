import {
  LegacyTranscriptError,
  type TranscriptFile,
  type TranscriptMessage,
  type TranscriptMeta,
} from './types.js'

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
  let parsed: TranscriptFile
  try {
    parsed = JSON.parse(raw) as TranscriptFile
  } catch (err) {
    // Re-throw JSON parse errors verbatim so callers see SyntaxError and
    // can distinguish "file corrupted" from "file from an unsupported
    // schema version" by error type.
    throw err
  }
  if (parsed.version === 1) {
    // v1 files persist messages under `raw.*` (SDK record shape) and lack
    // the v2 envelope (`cwd`/`userType`/`sessionId`). The runtime only
    // knows how to mount v2. Surface a typed error so the UI can present a
    // meaningful "this transcript predates the current format" message
    // rather than crashing on a missing cwd.
    throw new LegacyTranscriptError(
      `transcript is legacy v1 (raw SDK record); only v2 is supported — re-create the session or migrate manually`,
    )
  }
  if (parsed.version !== 2) {
    throw new Error(`Unsupported transcript version: ${parsed.version}`)
  }
  return parsed
}

export function extractMeta(file: TranscriptFile): TranscriptMeta {
  return {
    version: file.version,
    transcriptId: file.transcriptId,
    cwd: file.meta.cwd,
    model: file.meta.model,
    createdAt: file.meta.createdAt,
    updatedAt: file.meta.updatedAt,
    title: file.meta.title,
    tags: file.meta.tags,
    messageCount: file.messages.length,
    parentSessionId: file.meta.parentSessionId,
    subagentType: file.meta.subagentType,
    permissionMode: file.meta.permissionMode,
  }
}
