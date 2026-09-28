import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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

/**
 * 解析失败时的取证副本后缀。0 字节 / 截断的 `instances.json` 曾经让所有
 * 实例定义静默消失(2026-09-28),原因是 `readInstancesFile` 把 `JSON.parse('')`
 * 的异常和「文件不存在」当成同一件事返回空列表 —— 没有任何日志,UI 上只是
 * "实例都没了",无从判断是磁盘丢了还是根本没配过。
 */
export const CORRUPT_STATE_FILE = 'instances.json.corrupt'

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
  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch (err) {
    // ENOENT 是「被另一个进程刚删掉」,不算异常;其余(权限 / EISDIR)才报。
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { definitions: [], statuses: {} }
    console.warn(`[instanceStore] failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return { definitions: [], statuses: {} }
  }
  // 空文件 = 上一次写入被 SIGKILL 打断在 open('w') 之后、write 完成之前
  // (旧实现是直接覆盖写,没有 tmp+rename)。这跟「用户没配过实例」是两回事,
  // 不能同样静默返回空列表。
  if (raw.trim() === '') {
    console.warn(
      `[instanceStore] ${file} is empty — a previous write was interrupted. ` +
      `Every persisted instance definition has been lost.`,
    )
    await preserveCorruptState(file, raw)
    return { definitions: [], statuses: {} }
  }
  try {
    return JSON.parse(raw) as InstancesFile
  } catch (err) {
    console.warn(
      `[instanceStore] ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); ` +
      `treating as no instances and keeping a copy at ${file}.corrupt`,
    )
    await preserveCorruptState(file, raw)
    return { definitions: [], statuses: {} }
  }
}

/**
 * 把解析失败 / 为空的内容留一份取证副本,再把坏文件挪开。
 *
 * 为什么要「挪开」而不是只复制:留着 `instances.json` 的话,下一次
 * `writeInstancesFile` 的原子 rename 之前它会一直占着路径,下次启动又
 * 读到同一份坏数据。rename 成 `.corrupt` 之后路径是干净的,重启一次就能
 * 重新 hydrate —— 同时原件还在,不至于彻底丢。
 *
 * best-effort:取证失败不该让读路径抛错(读路径的契约是「永远返回一个
 * 可用的 InstancesFile」)。
 */
async function preserveCorruptState(file: string, raw: string): Promise<void> {
  const dest = `${file}.corrupt`
  try {
    await writeFile(dest, raw, 'utf-8')
    await unlink(file).catch(() => {})
  } catch (err) {
    console.warn(`[instanceStore] could not preserve corrupt state at ${dest}: ${err instanceof Error ? err.message : String(err)}`)
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
  // tmp + rename 而不是直接覆盖:rename 在同一文件系统内是原子的,读者
  // 要么看到旧内容要么看到新内容,**永远看不到 0 字节中间态**。直接
  // `writeFile(path, ...)` 会在 open('w') 截断后、内容写完前被 SIGKILL
  // 打中,留下一个空文件 —— 下次启动所有实例定义凭空消失,这就是
  // 2026-09-28 那次 `instances.json` 变成 0 字节的机制。
  // 写 tmp 也在锁内,避免两个进程交错产出半截内容。
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8')
    await rename(tmp, path)
  } catch (err) {
    // 失败时别把 tmp 留在数据目录里(下次写会撞同一个文件名)。
    await unlink(tmp).catch(() => {})
    throw err
  } finally {
    await release()
  }
}
