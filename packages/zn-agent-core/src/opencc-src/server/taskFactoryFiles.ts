import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomInt } from 'node:crypto'

export type TaskStatus = 'queued' | 'processing' | 'paused' | 'done' | 'failed'
export type TaskBucketName = 'queue-tasks' | 'processing-tasks' | 'finished-tasks'
export interface TaskSummary {
  id: string; title: string; status: string
  cwd: string
  description?: string
  agent?: string; createdAt?: string; startedAt?: string | null
  completedAt?: string | null; executorTaskId?: string | null
  bucket: TaskBucketName
}
export interface TaskBucket { queue: TaskSummary[]; processing: TaskSummary[]; finished: TaskSummary[] }
export interface TaskDetails { summary: TaskSummary; indexMd: string; specMd: string; planMd: string; processMd: string }

const BUCKETS: TaskBucketName[] = ['queue-tasks', 'processing-tasks', 'finished-tasks']
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

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

export interface CreatePoolTaskInput {
  id?: string; title: string; description?: string; agent?: string; spec?: string; plan?: string
  cwd?: string
}
export async function createPoolTask(input: CreatePoolTaskInput): Promise<TaskSummary> {
  const id = input.id ?? generateTaskId()
  const dir = taskDir('queue-tasks', id)
  if (existsSync(dir)) throw new Error(`task ${id} already exists`)
  const createdAt = new Date().toISOString()
  await mkdir(join(dir, 'docs'), { recursive: true })
  const esc = (s: string) => s.replace(/\n/g, ' ').replace(/:/g, '：') // frontmatter 防断行
  // cwd 是绝对路径（含 `:`），不能走 esc（esc 把 `:` 转全角破坏「读回 spawn」语义）——
  // 只防换行，不防冒号。约定 cwd 不允许内嵌换行（创建时若含则抛错）。
  const escCwd = (s: string) => {
    if (s.includes('\n')) throw new Error(`cwd must not contain newline: ${JSON.stringify(s)}`)
    return s
  }
  const taskCwd = input.cwd && input.cwd.trim() ? input.cwd.trim() : process.cwd()
  const indexMd = [
    '---',
    `id: ${id}`,
    `title: ${esc(input.title)}`,
    'status: queued',
    `agent: ${esc(input.agent ?? 'default')}`,
    `cwd: ${escCwd(taskCwd)}`,
    `createdAt: ${createdAt}`,
    'startedAt: null',
    'completedAt: null',
    'executorTaskId: null',
    '---',
    '',
    `# ${input.title}`,
    '',
    input.description ?? '',
    '',
  ].join('\n')
  await writeFile(join(dir, 'index.md'), indexMd, 'utf-8')
  await writeFile(join(dir, 'docs', 'spec.md'), input.spec ?? '# 需求规格\n\n（需求讨论后由主管补充）\n', 'utf-8')
  await writeFile(join(dir, 'docs', 'plan.md'), input.plan ?? '# 执行计划\n\n（执行前由主管补充）\n', 'utf-8')
  await writeFile(join(dir, 'process.md'), '# 执行记录\n\n', 'utf-8')
  return { id, title: input.title, status: 'queued', agent: input.agent, createdAt, cwd: taskCwd, bucket: 'queue-tasks' }
}

function parseIndexFrontmatter(text: string): Record<string, string | null> {
  const meta: Record<string, string | null> = {}
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!m) return meta
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    const raw = line.slice(i + 1).trim()
    meta[key] = raw === 'null' || raw === '' ? null : raw
  }
  return meta
}

function bodyAfterFrontmatter(text: string): string {
  const m = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(text)
  return m ? m[1]! : text
}

async function readIndex(id: string, bucket: TaskBucketName): Promise<{ text: string; meta: Record<string, string | null> } | null> {
  const file = join(taskDir(bucket, id), 'index.md')
  if (!existsSync(file)) return null
  const text = await readFile(file, 'utf-8')
  return { text, meta: parseIndexFrontmatter(text) }
}

/**
 * 从 index.md 正文提取任务描述摘要:frontmatter 之后、首个 `# <title>` 标题行
 * 下的第一个非空段(连续非空行),trim 后返回;无正文/仅标题 → undefined。
 * 不动 frontmatter schema — description 只读自正文首段。
 */
function extractDescription(text: string): string | undefined {
  const body = bodyAfterFrontmatter(text)
  const lines = body.split('\n')
  let idx = 0
  // 跳过头部的空行与 `# <title>` 标题行
  while (idx < lines.length) {
    const t = lines[idx]!.trim()
    if (t.startsWith('# ')) { idx++; break }
    if (t === '') { idx++; continue }
    if (/^#{1,6} /.test(t)) { idx++; continue }
    break // 正文直接以描述开始(无标题行)
  }
  // 跳过标题与正文之间的空行
  while (idx < lines.length && lines[idx]!.trim() === '') idx++
  const buf: string[] = []
  while (idx < lines.length) {
    const t = lines[idx]!.trim()
    if (t === '') break
    buf.push(t)
    idx++
  }
  const parsed = buf.join('\n').trim()
  return parsed.length > 0 ? parsed : undefined
}

function toSummary(id: string, bucket: TaskBucketName, meta: Record<string, string | null>, text?: string): TaskSummary {
  return {
    id, bucket,
    title: meta.title ?? id,
    status: meta.status ?? 'queued',
    cwd: meta.cwd ?? process.cwd(),
    description: text ? extractDescription(text) : undefined,
    agent: meta.agent ?? undefined,
    createdAt: meta.createdAt ?? undefined,
    startedAt: meta.startedAt ?? undefined,
    completedAt: meta.completedAt ?? undefined,
    executorTaskId: meta.executorTaskId ?? null,
  }
}

async function listIn(bucket: TaskBucketName): Promise<TaskSummary[]> {
  const root = taskFactoryRoot()
  const dir = join(root, bucket)
  if (!existsSync(dir)) return []
  const ids = (await readdir(dir)).filter((n) => !n.startsWith('.'))
  const out: TaskSummary[] = []
  for (const id of ids) {
    const rec = await readIndex(id, bucket)
    if (rec) out.push(toSummary(id, bucket, rec.meta, rec.text))
  }
  return out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
}

export async function listTasks(): Promise<TaskBucket> {
  const [queue, processing, finished] = await Promise.all(BUCKETS.map(listIn))
  return { queue, processing, finished }
}

export async function getTaskSummary(id: string, bucket?: TaskBucketName): Promise<TaskSummary | null> {
  const candidates: TaskBucketName[] = bucket ? [bucket] : BUCKETS
  for (const b of candidates) {
    const rec = await readIndex(id, b)
    if (rec) return toSummary(id, b, rec.meta, rec.text)
  }
  return null
}

function rewriteIndex(text: string, patch: Record<string, string | null>): string {
  // 逐行替换 frontmatter 内的 key；不在 frontmatter 内的 key 忽略
  // cwd 是绝对路径（含 `:`），不走通用 esc：只防换行。约定 patch.cwd 不允许含换行。
  const escRaw = (s: string) => {
    if (s.includes('\n')) throw new Error(`cwd must not contain newline: ${JSON.stringify(s)}`)
    return s
  }
  return text.replace(/^---\n([\s\S]*?)\n---/, (full, bodyStr: string) => {
    const lines = bodyStr.split('\n').map((line: string) => {
      const i = line.indexOf(':')
      if (i <= 0) return line
      const key = line.slice(0, i).trim()
      if (!(key in patch)) return line
      const v = patch[key]
      const escaped = v === null
        ? 'null'
        : key === 'cwd'
          ? escRaw(String(v))
          : String(v).replace(/\n/g, ' ').replace(/:/g, '：')
      return `${key}: ${escaped}`
    })
    return `---\n${lines.join('\n')}\n---`
  })
}

export async function markTaskStatus(
  id: string, bucket: TaskBucketName,
  patch: { status?: TaskStatus; startedAt?: string | null; completedAt?: string | null; executorTaskId?: string | null },
): Promise<TaskSummary> {
  const file = join(taskDir(bucket, id), 'index.md')
  const rec = await readIndex(id, bucket)
  if (!rec) throw new Error(`task ${id} not found in ${bucket}`)
  const next = rewriteIndex(rec.text, patch)
  await writeFile(file, next, 'utf-8')
  const meta = parseIndexFrontmatter(next)
  return toSummary(id, bucket, meta, next)
}

export async function moveTask(id: string, from: TaskBucketName, to: TaskBucketName): Promise<TaskSummary> {
  const rec = await readIndex(id, from)
  if (!rec) throw new Error(`task ${id} not found in ${from}`)
  const dest = taskDir(to, id)
  if (existsSync(dest)) throw new Error(`task ${id} already exists in ${to}`)
  const status = to === 'processing-tasks' ? 'processing' : to === 'finished-tasks' ? 'done' : 'queued'
  const nextText = rewriteIndex(rec.text, { status })
  // 先在原位置写好新 status，再 rename，避免 rename 成功后 writeFile 失败导致目录已移而 status 未更新
  await writeFile(join(taskDir(from, id), 'index.md'), nextText, 'utf-8')
  await mkdir(taskDir(to, ''), { recursive: true })
  await rename(taskDir(from, id), dest)
  return toSummary(id, to, parseIndexFrontmatter(nextText), nextText)
}

export async function deleteTasks(ids: string[]): Promise<void> {
  // 整批预校验：任一 id 非法（processing、不存在、两桶同存）则整体抛错，删除不开始，避免部分删除
  const buckets: TaskBucketName[] = await Promise.all(ids.map(async (id): Promise<TaskBucketName> => {
    const inProcessing = await getTaskSummary(id, 'processing-tasks')
    if (inProcessing) throw new Error(`task ${id} is processing/paused — cannot delete`)
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
  const [indexMd, specMd, planMd, processMd] = await Promise.all([
    read('index.md', ''), read('docs/spec.md', ''), read('docs/plan.md', ''), read('process.md', ''),
  ])
  return { summary, indexMd: bodyAfterFrontmatter(indexMd), specMd, planMd, processMd }
}

export { bodyAfterFrontmatter }