import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type RestartLogEvent = {
  type: string
  childPid: number | null
  durationMs?: number
  reason?: string
}

function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env.ZAI_DATA_DIR ?? join(homedir(), '.zai')
}

export function restartLogPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), 'logs', 'restart.jsonl')
}

/**
 * Append one JSONL line to ~/.zai/logs/restart.jsonl.
 *
 * Schema (per spec §5): `{ at, type, childPid, durationMs?, reason? }`.
 * Each call writes one line; the file is created lazily by appendFile.
 * `mkdir -p` ensures the parent dir exists on first write.
 *
 * Best-effort: a disk failure logs to stderr but never throws —
 * log writes must not block the supervisor's restart loop.
 */
export async function appendRestartLog(
  event: RestartLogEvent,
  dataDir?: string,
): Promise<void> {
  const dir = resolveDataDir(dataDir)
  const file = join(dir, 'logs', 'restart.jsonl')
  await mkdir(join(dir, 'logs'), { recursive: true })
  const line = JSON.stringify({ at: new Date().toISOString(), ...event })
  await appendFile(file, `${line}\n`, 'utf-8')
}