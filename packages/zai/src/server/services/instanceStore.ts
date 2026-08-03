import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import type { InstanceDefinition, InstanceStatus } from '../../shared/instances.js'

export interface InstancesFile {
  definitions: InstanceDefinition[]
  statuses: Record<string, InstanceStatus>
}

export const INSTANCE_STATE_FILE = 'instances.json'

export const EMPTY_INSTANCE_STATUS: InstanceStatus = {
  state: 'stopped',
  port: null,
  pid: null,
  startedAt: null,
  lastHeartbeatAt: null,
  lastError: null,
}

function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env.ZAI_DATA_DIR ?? join(homedir(), '.zai')
}

export function instancesFilePath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), INSTANCE_STATE_FILE)
}

export async function readInstancesFile(dataDir?: string): Promise<InstancesFile> {
  const file = instancesFilePath(dataDir)
  if (!existsSync(file)) return { definitions: [], statuses: {} }
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as InstancesFile
  } catch {
    return { definitions: [], statuses: {} }
  }
}

export async function writeInstancesFile(
  file: InstancesFile,
  dataDir?: string,
): Promise<void> {
  const dir = resolveDataDir(dataDir)
  const path = instancesFilePath(dir)
  await mkdir(dir, { recursive: true })
  // proper-lockfile requires the file to exist; create an empty default if missing
  if (!existsSync(path)) {
    await writeFile(path, JSON.stringify({ definitions: [], statuses: {} }, null, 2), 'utf-8')
  }
  const release = await lock(path, { retries: { retries: 5, minTimeout: 50, maxTimeout: 200 } })
  try {
    await writeFile(path, JSON.stringify(file, null, 2), 'utf-8')
  } finally {
    await release()
  }
}
