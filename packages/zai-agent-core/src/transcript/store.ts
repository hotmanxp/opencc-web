import { mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { lock } from 'proper-lockfile'
import type { TranscriptFile, TranscriptMessage, TranscriptMeta } from './types.js'
import { serializeFile, deserializeFile, extractMeta } from './serialization.js'
import { transcriptDir, transcriptPath, generateTranscriptId } from './paths.js'

export class TranscriptStore {
  constructor(private dataDir: string) {}

  async create(meta: Pick<TranscriptFile['meta'], 'cwd' | 'model'> & {
    parentSessionId?: string
    subagentType?: string
  }, id?: string): Promise<string> {
    await mkdir(transcriptDir(this.dataDir), { recursive: true })
    const transcriptId = id ?? generateTranscriptId()
    const file: TranscriptFile = {
      version: 2 as const,
      transcriptId,
      meta: { ...meta, createdAt: Date.now(), updatedAt: Date.now() },
      messages: [],
    }
    await writeFile(transcriptPath(this.dataDir, transcriptId), serializeFile(file), 'utf-8')
    return transcriptId
  }

  async read(transcriptId: string): Promise<TranscriptFile> {
    const raw = await readFile(transcriptPath(this.dataDir, transcriptId), 'utf-8')
    return deserializeFile(raw)
  }

  async append(transcriptId: string, msg: TranscriptMessage): Promise<void> {
    const filePath = transcriptPath(this.dataDir, transcriptId)
    const release = await lock(filePath, { retries: 3 })
    try {
      const raw = await readFile(filePath, 'utf-8')
      const file = deserializeFile(raw)
      file.messages.push(msg)
      file.meta.updatedAt = Date.now()
      await writeFile(filePath, serializeFile(file), 'utf-8')
    } finally {
      await release()
    }
  }

  async list(): Promise<TranscriptMeta[]> {
    const dir = transcriptDir(this.dataDir)
    try {
      const entries = await readdir(dir)
      const files = entries.filter((e) => e.endsWith('.json'))
      const metas: TranscriptMeta[] = []
      for (const file of files) {
        try {
          const raw = await readFile(join(dir, file), 'utf-8')
          const tf = deserializeFile(raw)
          metas.push(extractMeta(tf))
        } catch { /* skip corrupt files */ }
      }
      metas.sort((a, b) => b.updatedAt - a.updatedAt)
      return metas
    } catch {
      return []
    }
  }

  async patch(transcriptId: string, patch: { title?: string; tags?: string[]; model?: string }): Promise<void> {
    const filePath = transcriptPath(this.dataDir, transcriptId)
    const release = await lock(filePath, { retries: 3 })
    try {
      const raw = await readFile(filePath, 'utf-8')
      const file = deserializeFile(raw)
      if (patch.title !== undefined) file.meta.title = patch.title
      if (patch.tags !== undefined) file.meta.tags = patch.tags
      if (patch.model !== undefined) file.meta.model = patch.model
      file.meta.updatedAt = Date.now()
      await writeFile(filePath, serializeFile(file), 'utf-8')
    } finally {
      await release()
    }
  }

  async remove(transcriptId: string): Promise<void> {
    const filePath = transcriptPath(this.dataDir, transcriptId)
    const release = await lock(filePath, { retries: 3 })
    try {
      await unlink(filePath)
    } finally {
      await release().catch(() => {})
    }
  }
}