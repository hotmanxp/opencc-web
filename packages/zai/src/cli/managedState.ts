import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'

export type ManagedState = {
  supervisorPid: number
  state: 'starting' | 'running' | 'restarting' | 'failed'
  childPid: number | null
  startedAt: string
  restarts: number
  lastError: { at: string; message: string } | null
}

function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env.ZAI_DATA_DIR ?? join(homedir(), '.zai')
}

export function managedStatePath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), 'state', 'managed.json')
}

async function readRaw(dataDir: string): Promise<ManagedState | null> {
  const file = managedStatePath(dataDir)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as ManagedState
  } catch {
    return null
  }
}

export async function readManagedState(dataDir?: string): Promise<ManagedState | null> {
  return readRaw(resolveDataDir(dataDir))
}

export async function writeManagedState(patch: Partial<ManagedState>, dataDir?: string): Promise<void> {
  const dir = resolveDataDir(dataDir)
  const file = managedStatePath(dir)
  await mkdir(join(dir, 'state'), { recursive: true })
  // proper-lockfile requires the file to exist; create it with defaults if missing
  if (!existsSync(file)) {
    await writeFile(file, JSON.stringify({
      supervisorPid: process.pid, state: 'starting',
      childPid: null, startedAt: new Date().toISOString(),
      restarts: 0, lastError: null,
    }, null, 2), 'utf-8')
  }
  const release = await lock(file, { retries: { retries: 5, minTimeout: 50, maxTimeout: 200 } })
  try {
    const current = (await readRaw(dir)) ?? {
      supervisorPid: process.pid, state: 'starting',
      childPid: null, startedAt: new Date().toISOString(),
      restarts: 0, lastError: null,
    }
    const next: ManagedState = { ...current, ...patch }
    await writeFile(file, JSON.stringify(next, null, 2), 'utf-8')
  } finally {
    await release()
  }
}
