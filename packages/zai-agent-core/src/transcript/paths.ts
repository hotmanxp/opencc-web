import { randomUUID } from 'crypto'
import { join } from 'path'

export function transcriptDir(dataDir: string): string {
  return join(dataDir, 'transcripts')
}

export function transcriptPath(dataDir: string, transcriptId: string): string {
  return join(transcriptDir(dataDir), `${transcriptId}.json`)
}

export function generateTranscriptId(): string {
  return `sess-${randomUUID()}`
}

export function parseTranscriptId(id: string): string | null {
  return /^sess-[0-9a-f-]{36}$/i.test(id) ? id : null
}