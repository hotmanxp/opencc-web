import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomInt } from 'node:crypto'
import YAML from 'yaml'

export type TaskStatus = 'queued' | 'processing' | 'paused' | 'verifying' | 'done' | 'failed'
export type TaskBucketName = 'queue-tasks' | 'processing-tasks' | 'verifying-tasks' | 'finished-tasks'
export interface TaskSummary {
  id: string; title: string; status: string
  cwd: string
  description?: string
  agent?: string
  /** 验证 subagent 名称(可选;默认沿用 `agent`)。SpawnAgent 调验证子任务时使用。 */
  verifierAgent?: string | null
  createdAt?: string; startedAt?: string | null
  completedAt?: string | null; executorTaskId?: string | null
  bucket: TaskBucketName
}
export interface TaskBucket {
  queue: TaskSummary[]
  processing: TaskSummary[]
  verifying: TaskSummary[]
  finished: TaskSummary[]
}
/**
 * 任务详情。task.yaml 是任务元数据的唯一权威源(id/title/status/agent/
 * verifierAgent/cwd/createdAt/startedAt/completedAt/executorTaskId/description)。
 * 历史版本的 `index.md`(YAML frontmatter + markdown 正文首段 description)
 * 在读取时仍兼容解析,但所有新写都走 task.yaml。
 */
export interface TaskDetails { summary: TaskSummary; specMd: string; planMd: string; processMd: string }

const BUCKETS: TaskBucketName[] = ['queue-tasks', 'processing-tasks', 'verifying-tasks', 'finished-tasks']
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 新格式任务元数据文件名(2026-09-02 起替代 index.md)。 */
export const TASK_YAML_FILENAME = 'task.yaml'
/** 历史文件名,只读兼容;不再由本模块写入。 */
export const LEGACY_INDEX_MD_FILENAME = 'index.md'

/** task.yaml 顶层字段集合(写入/校验都用它做白名单,避免无关字段被序列化进去)。 */
const TASK_YAML_FIELDS = [
  'id', 'title', 'status', 'agent', 'verifierAgent', 'cwd',
  'description', 'createdAt', 'startedAt', 'completedAt', 'executorTaskId',
] as const

/** 任务在 yaml 里允许的 status 字符串。 */
type TaskYamlScalar =
  | string
  | number
  | boolean
  | null
  | undefined
/** task.yaml 的内存表示(扁平 key-value)。null 表示字段被显式置空。 */
export type TaskYaml = Record<(typeof TASK_YAML_FIELDS)[number], TaskYamlScalar>

export function taskFactoryRoot(): string {
  return process.env.ZAI_TASK_FACTORY_DIR ?? join(homedir(), '.zai', 'task-factory')
}
export function taskDir(bucket: TaskBucketName, id: string): string {
  return join(taskFactoryRoot(), bucket, id)
}
export function generateTaskId(): string {
  let id = 'tf-'
  for (let i = 0; i < 8; i++) id += TASK_ID_ALPHABET[randomInt(TASK_ID_ALPHABET.length)]!
  return id
}

/** 事件 bridge（zai server 启动时注入 __zaiTaskFactoryEmitter；纯 core 环境 no-op）。 */
export function emitTaskFactoryEvent(action: string, payload: Record<string, unknown>): void {
  const emitter = (globalThis as { __zaiTaskFactoryEmitter?: (e: { action: string; payload: Record<string, unknown> }) => void })
    .__zaiTaskFactoryEmitter
  emitter?.({ action, payload })
}

/**
 * 把 TaskYaml 序列化成 YAML 文本(键序固定为 TASK_YAML_FIELDS,便于 diff/审计)。
 * 使用 block scalar(`|`)承载长字符串(title/description/spec)—— 不做 escape
 * 转义,也不需要 frontmatter 那种 `:` 全角化的 hack(YAML 是结构化语法,
 * 字符串原生支持换行与冒号)。空字符串序列化成 `''`(保留 key,便于 patch)。
 */
function serializeTaskYaml(meta: Partial<TaskYaml>): string {
  const out: Record<string, unknown> = {}
  for (const k of TASK_YAML_FIELDS) {
    if (!(k in meta)) continue
    const v = meta[k]
    if (v === undefined) continue
    out[k] = v
  }
  return YAML.stringify(out, { sortMapEntries: false, lineWidth: 0 })
}

/** 解析 task.yaml 文本为 TaskYaml。空文件/缺失字段都安全(默认 undefined)。 */
function parseTaskYaml(text: string): TaskYaml {
  const parsed = (YAML.parse(text) ?? {}) as Record<string, unknown>
  const out = {} as TaskYaml
  for (const k of TASK_YAML_FIELDS) {
    const v = parsed[k]
    if (v === null) out[k] = null
    else if (v === undefined) continue
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v
    }
  }
  return out
}

/**
 * 历史 index.md 解析(YAML frontmatter + markdown 正文首段)。
 * 仅在读路径兼容,新写不再调用。frontmatter 不带 `:` 全角化,description
 * 取首段(连续非空行)trim。空 description 返回 undefined。
 */
function parseLegacyIndexMd(text: string): TaskYaml {
  const meta: TaskYaml = {} as TaskYaml
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)
  if (fm) {
    for (const line of fm[1]!.split('\n')) {
      const i = line.indexOf(':')
      if (i <= 0) continue
      const key = line.slice(0, i).trim() as (typeof TASK_YAML_FIELDS)[number]
      if (!(TASK_YAML_FIELDS as readonly string[]).includes(key)) continue
      const raw = line.slice(i + 1).trim()
      meta[key] = raw === 'null' || raw === '' ? null : raw
    }
  }
  // 从正文首段提取 description(沿用旧 extractDescription 规则)
  const bodyMatch = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(text)
  const body = bodyMatch ? bodyMatch[1]! : text
  const lines = body.split('\n')
  let idx = 0
  while (idx < lines.length) {
    const t = lines[idx]!.trim()
    if (t.startsWith('# ')) { idx++; break }
    if (t === '') { idx++; continue }
    if (/^#{1,6} /.test(t)) { idx++; continue }
    break
  }
  while (idx < lines.length && lines[idx]!.trim() === '') idx++
  const buf: string[] = []
  while (idx < lines.length) {
    const t = lines[idx]!.trim()
    if (t === '') break
    buf.push(t)
    idx++
  }
  const desc = buf.join('\n').trim()
  if (desc.length > 0) meta.description = desc
  return meta
}

export interface CreatePoolTaskInput {
  id?: string; title: string; description?: string; agent?: string; spec?: string; plan?: string
  cwd?: string
  /** 验证 subagent 名称(可选);缺省回落到任务 `agent` 字段。SpawnAgent 验证时使用。 */
  verifierAgent?: string
}
export async function createPoolTask(input: CreatePoolTaskInput): Promise<TaskSummary> {
  const id = input.id ?? generateTaskId()
  const dir = taskDir('queue-tasks', id)
  if (existsSync(dir)) throw new Error(`task ${id} already exists`)
  const createdAt = new Date().toISOString()
  await mkdir(join(dir, 'docs'), { recursive: true })
  // cwd 是绝对路径(含 `:`),绝对不能做 `:` → `：` 全角化(YAML 字符串不需要
  // 转义,原样写即可);约定 cwd 不允许内嵌换行(避免破坏单行字符串语义)。
  if (input.cwd && input.cwd.includes('\n')) {
    throw new Error(`cwd must not contain newline: ${JSON.stringify(input.cwd)}`)
  }
  const taskCwd = input.cwd && input.cwd.trim() ? input.cwd.trim() : process.cwd()
  const meta: TaskYaml = {
    id,
    title: input.title,
    status: 'queued',
    agent: input.agent ?? 'default',
    verifierAgent: input.verifierAgent ?? null,
    cwd: taskCwd,
    description: input.description ?? null,
    createdAt,
    startedAt: null,
    completedAt: null,
    executorTaskId: null,
  }
  await writeFile(join(dir, TASK_YAML_FILENAME), serializeTaskYaml(meta), 'utf-8')
  await writeFile(join(dir, 'docs', 'spec.md'), input.spec ?? '# 需求规格\n\n（需求讨论后由主管补充）\n', 'utf-8')
  await writeFile(join(dir, 'docs', 'plan.md'), input.plan ?? '# 执行计划\n\n（执行前由主管补充）\n', 'utf-8')
  await writeFile(join(dir, 'process.md'), '# 执行记录\n\n', 'utf-8')
  return {
    id,
    title: input.title,
    status: 'queued',
    agent: input.agent,
    verifierAgent: input.verifierAgent ?? null,
    createdAt,
    cwd: taskCwd,
    description: input.description,
    bucket: 'queue-tasks',
  }
}

/**
 * 读任务的 task.yaml(优先)或 legacy index.md(回退)。返回 meta + 文本来源。
 * 触发 legacy 命中时,同步迁移:写入 task.yaml,删除旧 index.md(2026-09-02 起
 * 双兼容策略)。迁移失败不抛(下次再迁),只回退 meta 内容。
 */
async function readTaskMeta(id: string, bucket: TaskBucketName): Promise<TaskYaml | null> {
  const dir = taskDir(bucket, id)
  const yamlPath = join(dir, TASK_YAML_FILENAME)
  const legacyPath = join(dir, LEGACY_INDEX_MD_FILENAME)
  if (existsSync(yamlPath)) {
    const text = await readFile(yamlPath, 'utf-8')
    return parseTaskYaml(text)
  }
  if (existsSync(legacyPath)) {
    const text = await readFile(legacyPath, 'utf-8')
    const meta = parseLegacyIndexMd(text)
    // 迁移:尽力而为;失败不抛(下次再迁)
    try {
      await writeFile(yamlPath, serializeTaskYaml(meta), 'utf-8')
      await rm(legacyPath)
    } catch {
      // ignore — 读取路径仍然成功,下次再试
    }
    return meta
  }
  return null
}

function toSummary(id: string, bucket: TaskBucketName, meta: TaskYaml): TaskSummary {
  return {
    id, bucket,
    title: meta.title ?? id,
    status: meta.status ?? 'queued',
    cwd: meta.cwd ?? process.cwd(),
    description: meta.description == null ? undefined : String(meta.description),
    agent: meta.agent == null ? undefined : String(meta.agent),
    verifierAgent: meta.verifierAgent == null ? null : String(meta.verifierAgent),
    createdAt: meta.createdAt == null ? undefined : String(meta.createdAt),
    startedAt: meta.startedAt == null ? undefined : String(meta.startedAt),
    completedAt: meta.completedAt == null ? undefined : String(meta.completedAt),
    executorTaskId: meta.executorTaskId == null ? null : String(meta.executorTaskId),
  }
}

async function listIn(bucket: TaskBucketName): Promise<TaskSummary[]> {
  const root = taskFactoryRoot()
  const dir = join(root, bucket)
  if (!existsSync(dir)) return []
  const ids = (await readdir(dir)).filter((n) => !n.startsWith('.'))
  const out: TaskSummary[] = []
  for (const id of ids) {
    const meta = await readTaskMeta(id, bucket)
    if (meta) out.push(toSummary(id, bucket, meta))
  }
  return out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
}

export async function listTasks(): Promise<TaskBucket> {
  const [queue, processing, verifying, finished] = await Promise.all(BUCKETS.map(listIn))
  return { queue, processing, verifying, finished }
}

export async function getTaskSummary(id: string, bucket?: TaskBucketName): Promise<TaskSummary | null> {
  const candidates: TaskBucketName[] = bucket ? [bucket] : BUCKETS
  for (const b of candidates) {
    const meta = await readTaskMeta(id, b)
    if (meta) return toSummary(id, b, meta)
  }
  return null
}

/**
 * 写一份新的 task.yaml:基于已有 meta + patch 合并,然后整体覆盖写回。
 * patch 里 key → string 视为写入;key → null 视为显式置空;key 缺省视为不改。
 * cwd patch 不允许含换行(单行字符串语义);description patch 多行原样写
 * (YAML block scalar 原生支持)。
 */
async function writeTaskMeta(id: string, bucket: TaskBucketName, patch: Partial<TaskYaml>): Promise<TaskYaml> {
  const dir = taskDir(bucket, id)
  const yamlPath = join(dir, TASK_YAML_FILENAME)
  const legacyPath = join(dir, LEGACY_INDEX_MD_FILENAME)
  // 读旧 meta(task.yaml 优先;否则走 legacy 一次性迁移)
  let base: TaskYaml
  if (existsSync(yamlPath)) {
    base = parseTaskYaml(await readFile(yamlPath, 'utf-8'))
  } else if (existsSync(legacyPath)) {
    base = parseLegacyIndexMd(await readFile(legacyPath, 'utf-8'))
  } else {
    throw new Error(`task ${id} not found in ${bucket}`)
  }
  const next: TaskYaml = { ...base }
  for (const [k, v] of Object.entries(patch) as [(typeof TASK_YAML_FIELDS)[number], TaskYamlScalar][]) {
    if (k === 'cwd' && typeof v === 'string' && v.includes('\n')) {
      throw new Error(`cwd must not contain newline: ${JSON.stringify(v)}`)
    }
    next[k] = v
  }
  await writeFile(yamlPath, serializeTaskYaml(next), 'utf-8')
  // 旧文件存在则一并清掉
  if (existsSync(legacyPath)) {
    await rm(legacyPath).catch(() => {})
  }
  return next
}

export async function markTaskStatus(
  id: string, bucket: TaskBucketName,
  patch: { status?: TaskStatus; startedAt?: string | null; completedAt?: string | null; executorTaskId?: string | null },
): Promise<TaskSummary> {
  const next = await writeTaskMeta(id, bucket, patch)
  return toSummary(id, bucket, next)
}

export async function moveTask(id: string, from: TaskBucketName, to: TaskBucketName): Promise<TaskSummary> {
  const meta = await readTaskMeta(id, from)
  if (!meta) throw new Error(`task ${id} not found in ${from}`)
  const status = to === 'processing-tasks' ? 'processing'
    : to === 'verifying-tasks' ? 'verifying'
    : to === 'finished-tasks' ? 'done'
    : 'queued'
  const dest = taskDir(to, id)
  if (existsSync(dest)) throw new Error(`task ${id} already exists in ${to}`)
  // 先在原位置写好新 status，再 rename，避免 rename 成功后 writeFile 失败导致目录已移而 status 未更新
  await writeTaskMeta(id, from, { status })
  await mkdir(taskDir(to, ''), { recursive: true })
  await rename(taskDir(from, id), dest)
  return toSummary(id, to, { ...meta, status })
}

export async function deleteTasks(ids: string[]): Promise<void> {
  // 整批预校验：任一 id 非法（processing/verifying、不存在、两桶同存）则整体抛错，删除不开始，避免部分删除
  const buckets: TaskBucketName[] = await Promise.all(ids.map(async (id): Promise<TaskBucketName> => {
    const [inProcessing, inVerifying] = await Promise.all([
      getTaskSummary(id, 'processing-tasks'),
      getTaskSummary(id, 'verifying-tasks'),
    ])
    if (inProcessing) throw new Error(`task ${id} is processing/paused — cannot delete`)
    if (inVerifying) throw new Error(`task ${id} is verifying — cannot delete`)
    const [inQueue, inFinished] = await Promise.all([
      getTaskSummary(id, 'queue-tasks'),
      getTaskSummary(id, 'finished-tasks'),
    ])
    if (inQueue && inFinished) throw new Error(`task ${id} exists in both queue-tasks and finished-tasks — ambiguous delete target`)
    if (inQueue) return 'queue-tasks'
    if (inFinished) return 'finished-tasks'
    throw new Error(`task ${id} not found`)
  }))
  // 校验全部通过后，再逐个删除
  for (let i = 0; i < ids.length; i++) {
    await rm(taskDir(buckets[i]!, ids[i]!), { recursive: true, force: true })
  }
}

export async function getTaskDetails(id: string, bucket?: TaskBucketName): Promise<TaskDetails | null> {
  const summary = await getTaskSummary(id, bucket)
  if (!summary) return null
  const dir = taskDir(summary.bucket, id)
  const read = async (name: string, fallback: string) => {
    const f = join(dir, name)
    return existsSync(f) ? readFile(f, 'utf-8') : fallback
  }
  const [specMd, planMd, processMd] = await Promise.all([
    read('docs/spec.md', ''), read('docs/plan.md', ''), read('process.md', ''),
  ])
  return { summary, specMd, planMd, processMd }
}

export { serializeTaskYaml, parseTaskYaml, parseLegacyIndexMd, TASK_YAML_FIELDS }
