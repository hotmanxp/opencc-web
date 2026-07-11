import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { RuntimeConfig } from './types.js'

export async function abortSession(
  config: RuntimeConfig,
  sessionId: string,
  reason?: string
): Promise<void> {
  const abortDir = join(config.dataDir, 'runtime', 'aborts')
  await mkdir(abortDir, { recursive: true })
  await writeFile(
    join(abortDir, `${sessionId}.abort`),
    JSON.stringify({ sessionId, reason: reason || 'user cancelled', timestamp: Date.now() }),
    'utf-8'
  )
}