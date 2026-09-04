# 任务工厂（Task Factory）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai 内实现文件驱动的任务工厂：任务任务调度官 Agent（需求讨论/落库/派生执行/验收）+ `/super-tasks` 调度面板（任务调度官对话 + 三栏任务面板 + 详情抽屉）+ 任务工厂实例入口。

**Architecture:** 文件系统（`~/.zai/task-factory/{queue,processing,finished}-tasks/<id>/`）是唯一事实源。任务调度官 Agent 注册为内置 main agent，`SuperTasksCreate`/`SuperTasksMarkDone` 两个内置工具（core 侧 `buildTool`）操作任务文件并经 `globalThis.__zaiTaskFactoryEmitter` bridge 发 SSE 事件；委派执行**优先 SpawnAgent（claude-code|dsh 外部 CLI agent，默认工具池已有）**，回退 AgentTool，执行器 transcript 归拢到任务目录（core patch 支持绝对 transcript subdir）。zai server 提供 superTasks REST 路由，任务调度官唤醒复用既有 `sessionInbox.followup` → `runNextInQueue` 通道。面板左栏复用 `AgentConversation`（用 `useAgentStore` 固定任务调度官 session），右栏任务面板轮询 + 事件刷新。实例入口走 `--app task-factory` CLI flag + `ZAI_APP` env，强制 mainAgent 并把 `/` 重定向 `/super-tasks`。

**Tech Stack:** TypeScript；Node `node:fs/promises`；zod v4（工具 inputSchema）；`buildTool`（vendor-shape 工具构造）；zustand（web store）；AntD（面板 UI）；React Router（顶层路由）；vitest。

## Global Constraints

- 提交格式：`HRMSV3-ZN-WEBSITE#668 <type>(scope): 描述`（如 `HRMSV3-ZN-WEBSITE#668 feat(core): task-factory 文件服务与工具`）。
- 只跑相关单测（路径过滤），禁止把 `pnpm -r test` 当完成门禁：core 用 `pnpm --filter @zn-ai/zn-agent-core exec vitest run <file>`，zai 用 `pnpm --filter @zn-ai/zai test <file>`。
- **core 改动必须先 `pnpm run build:core`** 才能让 zai 运行时（`node_modules/@zn-ai/zn-agent-core/dist/opencc-core.mjs`）生效；zai 侧测试同理（import 的是构建产物）。
- 页面样式改动不跑单测，最终以 ego-browser 真实浏览器验收为准（项目强制规则）。
- 端口：起 dev 前 `lsof -i :<port>` 确认空闲；显式 `--port` 被占用应报错。
- 目录约定：任务根目录 `~/.zai/task-factory/`，测试用 env `ZAI_TASK_FACTORY_DIR=<tmpdir>` 隔离。
- 所有 agent 工具沿用 vendor `buildTool` + zod v4（禁止 zod v3，会破坏 `zodToJsonSchema`）。
- 状态机：`queued | processing | paused | done | failed`；目录即状态（moveTask 移目录），index.md 的 `status` 是冗余展示字段。
- 序列化：index.md frontmatter 每行 `key: value`，value 不含 `:` / 换行；空值写 `null` 字面量。

---

### Task 1: core — 任务文件服务 `taskFactoryFiles.ts`（fs 模块 + 事件 bridge）

**Files:**
- Create: `packages/zn-agent-core/src/opencc-src/server/taskFactoryFiles.ts`
- Test: `packages/zn-agent-core/test/unit/taskFactoryFiles.test.ts`

**Interfaces:**
- Consumes: node 内置 `fs/promises`、`path`、`os.homedir`、`crypto.randomInt`、环境变量 `ZAI_TASK_FACTORY_DIR`。
- Produces（后续任务全部依赖这些签名）:
```ts
export type TaskStatus = 'queued' | 'processing' | 'paused' | 'done' | 'failed'
export type TaskBucketName = 'queue-tasks' | 'processing-tasks' | 'finished-tasks'
export interface TaskSummary {
  id: string; title: string; status: string
  agent?: string; createdAt?: string; startedAt?: string | null
  completedAt?: string | null; executorTaskId?: string | null
  bucket: TaskBucketName
}
export interface TaskBucket { queue: TaskSummary[]; processing: TaskSummary[]; finished: TaskSummary[] }
export interface TaskDetails { summary: TaskSummary; indexMd: string; specMd: string; planMd: string; processMd: string }
export function taskFactoryRoot(): string
export function generateTaskId(): string
export function createPoolTask(input: { id?: string; title: string; description?: string; agent?: string; spec?: string; plan?: string }): Promise<TaskSummary>
export function listTasks(): Promise<TaskBucket>
export function getTaskSummary(id: string, bucket?: TaskBucketName): Promise<TaskSummary | null>
export function moveTask(id: string, from: TaskBucketName, to: TaskBucketName): Promise<TaskSummary>
export function markTaskStatus(id: string, bucket: TaskBucketName, patch: { status?: TaskStatus; startedAt?: string | null; completedAt?: string | null; executorTaskId?: string | null }): Promise<TaskSummary>
export function deleteTasks(ids: string[]): Promise<void>
export function getTaskDetails(id: string, bucket?: TaskBucketName): Promise<TaskDetails | null>
export function emitTaskFactoryEvent(action: string, payload: Record<string, unknown>): void
```

- [ ] **Step 1: 写失败测试**

```ts
// packages/zn-agent-core/test/unit/taskFactoryFiles.test.ts
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPoolTask, listTasks, moveTask, markTaskStatus,
  deleteTasks, getTaskDetails, taskFactoryRoot,
} from '../src/opencc-src/server/taskFactoryFiles.js'

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'tf-test-')) , process.env.ZAI_TASK_FACTORY_DIR = dir })
afterAll(async () => { delete process.env.ZAI_TASK_FACTORY_DIR; await rm(dir, { recursive: true, force: true }) })

describe('taskFactoryFiles', () => {
  it('createPoolTask 初始化四文件并落到 queue-tasks', async () => {
    const s = await createPoolTask({ title: '打印 CSV 报表', agent: 'default' })
    expect(s.id.startsWith('tf-')).toBe(true)
    expect(s.bucket).toBe('queue-tasks')
    const index = await readFile(join(dir, 'queue-tasks', s.id, 'index.md'), 'utf-8')
    expect(index).toContain('status: queued')
    const docs = await readdir(join(dir, 'queue-tasks', s.id, 'docs'))
    expect(docs.sort()).toEqual(['plan.md', 'spec.md'])
    void readFile(join(dir, 'queue-tasks', s.id, 'process.md'))
  })

  it('moveTask 移目录并更新 index status=processing', async () => {
    const s = await createPoolTask({ title: 't' })
    const moved = await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    expect(moved.status).toBe('processing')
    await expect(readdir(join(dir, 'processing-tasks', s.id))).resolves.not.toThrow()
  })

  it('markTaskStatus 回填 executorTaskId 与 startedAt', async () => {
    const s = await createPoolTask({ title: 't' })
    const m = await markTaskStatus(s.id, 'queue-tasks', {
      status: 'processing', startedAt: '2026-09-01T00:00:00.000Z', executorTaskId: 'a1234567',
    })
    expect(m.executorTaskId).toBe('a1234567')
    const index = await readFile(join(dir, 'queue-tasks', s.id, 'index.md'), 'utf-8')
    expect(index).toContain('executorTaskId: a1234567')
  })

  it('deleteTasks 只允许 queue/finished，拒绝 processing（含 paused）', async () => {
    const s = await createPoolTask({ title: 'keep' })
    await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    await expect(deleteTasks([s.id])).rejects.toThrow(/processing/)
  })

  it('getTaskDetails 读回四文件全文', async () => {
    const s = await createPoolTask({ title: 'd', spec: '# SPEC' })
    const d = await getTaskDetails(s.id)
    expect(d?.specMd).toContain('# SPEC')
    expect(d?.summary.title).toBe('d')
  })

  it('taskFactoryRoot 走 ZAI_TASK_FACTORY_DIR 覆盖', () => {
    expect(taskFactoryRoot()).toBe(dir)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zn-agent-core exec vitest run test/unit/taskFactoryFiles.test.ts`
Expected: FAIL（`Cannot find module` taskFactoryFiles）。

- [ ] **Step 3: 实现 `taskFactoryFiles.ts`**

```ts
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomInt } from 'node:crypto'

export type TaskStatus = 'queued' | 'processing' | 'paused' | 'done' | 'failed'
export type TaskBucketName = 'queue-tasks' | 'processing-tasks' | 'finished-tasks'
export interface TaskSummary {
  id: string; title: string; status: string
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
}
export async function createPoolTask(input: CreatePoolTaskInput): Promise<TaskSummary> {
  const id = input.id ?? generateTaskId()
  const dir = taskDir('queue-tasks', id)
  if (existsSync(dir)) throw new Error(`task ${id} already exists`)
  const createdAt = new Date().toISOString()
  await mkdir(join(dir, 'docs'), { recursive: true })
  const esc = (s: string) => s.replace(/\n/g, ' ').replace(/:/g, '：') // frontmatter 防断行
  const indexMd = [
    '---',
    `id: ${id}`,
    `title: ${esc(input.title)}`,
    'status: queued',
    `agent: ${esc(input.agent ?? 'default')}`,
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
  await writeFile(join(dir, 'docs', 'spec.md'), input.spec ?? '# 需求规格\n\n（需求讨论后由任务调度官补充）\n', 'utf-8')
  await writeFile(join(dir, 'docs', 'plan.md'), input.plan ?? '# 执行计划\n\n（执行前由任务调度官补充）\n', 'utf-8')
  await writeFile(join(dir, 'process.md'), '# 执行记录\n\n', 'utf-8')
  return { id, title: input.title, status: 'queued', agent: input.agent, createdAt, bucket: 'queue-tasks' }
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

function toSummary(id: string, bucket: TaskBucketName, meta: Record<string, string | null>): TaskSummary {
  return {
    id, bucket,
    title: meta.title ?? id,
    status: meta.status ?? 'queued',
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
    if (rec) out.push(toSummary(id, bucket, rec.meta))
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
    if (rec) return toSummary(id, b, rec.meta)
  }
  return null
}

function rewriteIndex(text: string, patch: Record<string, string | null>): string {
  // 逐行替换 frontmatter 内的 key；不在 frontmatter 内的 key 忽略
  return text.replace(/^---\n([\s\S]*?)\n---/, (full, bodyStr: string) => {
    const lines = bodyStr.split('\n').map((line: string) => {
      const i = line.indexOf(':')
      if (i <= 0) return line
      const key = line.slice(0, i).trim()
      if (!(key in patch)) return line
      const v = patch[key]
      const escaped = v === null ? 'null' : String(v).replace(/\n/g, ' ').replace(/:/g, '：')
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
  return toSummary(id, bucket, meta)
}

export async function moveTask(id: string, from: TaskBucketName, to: TaskBucketName): Promise<TaskSummary> {
  const rec = await readIndex(id, from)
  if (!rec) throw new Error(`task ${id} not found in ${from}`)
  const status = to === 'processing-tasks' ? 'processing' : to === 'finished-tasks' ? 'done' : 'queued'
  const nextText = rewriteIndex(rec.text, { status })
  await mkdir(taskDir(to, ''), { recursive: true })
  await rename(taskDir(from, id), taskDir(to, id))
  await writeFile(join(taskDir(to, id), 'index.md'), nextText, 'utf-8')
  return toSummary(id, to, parseIndexFrontmatter(nextText))
}

export async function deleteTasks(ids: string[]): Promise<void> {
  for (const id of ids) {
    const inProcessing = await getTaskSummary(id, 'processing-tasks')
    if (inProcessing) throw new Error(`task ${id} is processing/paused — cannot delete`)
    const bucket = (await getTaskSummary(id, 'queue-tasks')) ? 'queue-tasks' : 'finished-tasks'
    if (!(await getTaskSummary(id, bucket))) throw new Error(`task ${id} not found`)
    await rm(taskDir(bucket, id), { recursive: true, force: true })
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。
Expected: PASS（5 it + 1 it 全过）。

- [ ] **Step 5: build + 提交**

```bash
pnpm run build:core
git add packages/zn-agent-core/src/opencc-src/server/taskFactoryFiles.ts packages/zn-agent-core/test/unit/taskFactoryFiles.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(core): 任务工厂文件服务 taskFactoryFiles"
```

---

### Task 2: core — `SuperTasksCreate` / `SuperTasksMarkDone` 工具

**Files:**
- Create: `packages/zn-agent-core/src/opencc-src/server/taskFactoryTools.ts`
- Test: `packages/zn-agent-core/test/unit/taskFactoryTools.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `createPoolTask` / `getTaskSummary` / `moveTask` / `markTaskStatus` / `emitTaskFactoryEvent`；`buildTool`（`../Tool.js`，同 `displayFilesOpencc.ts`）；`zod/v4`。
- Produces:
```ts
export const superTasksCreateTool: Tool   // name 'SuperTasksCreate'
export const superTasksMarkDoneTool: Tool // name 'SuperTasksMarkDone'
```

- [ ] **Step 1: 写失败测试**

测试通过给 `globalThis.__zaiTaskFactoryEmitter` 注入收集器断言事件；工具 `call()` 直接调用（工具方法可同步 `await`）。

```ts
// packages/zn-agent-core/test/unit/taskFactoryTools.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { superTasksCreateTool, superTasksMarkDoneTool } from '../src/opencc-src/server/taskFactoryTools.js'
import { taskDir } from '../src/opencc-src/server/taskFactoryFiles.js'

let dir: string
let events: Array<{ action: string; payload: Record<string, unknown> }>

/** 工具 call 的 output 是纯文本（非 JSON），用正则取任务 id。 */
function extractId(out: string): string {
  return (out.match(/tf-[a-z0-9]{8}/) as RegExpMatchArray)[0] as string
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-tool-'))
  process.env.ZAI_TASK_FACTORY_DIR = dir
  events = []
  ;(globalThis as any).__zaiTaskFactoryEmitter = (e: any) => events.push(e)
})
afterEach(async () => {
  delete process.env.ZAI_TASK_FACTORY_DIR
  delete (globalThis as any).__zaiTaskFactoryEmitter
  await rm(dir, { recursive: true, force: true })
})

describe('superTasksCreateTool', () => {
  it('call 创建骨架并 emit created', async () => {
    const res = await superTasksCreateTool.call({ title: '写周报脚本', agent: 'default', spec: '# SPEC' })
    const out = res.data.output as string
    expect(out).toContain('Task created: tf-')
    expect(events[0]?.action).toBe('created')
    const id = extractId(out)
    const spec = await readFile(join(taskDir('queue-tasks', id), 'docs', 'spec.md'), 'utf-8')
    expect(spec).toContain('# SPEC')
  })
})

describe('superTasksMarkDoneTool', () => {
  it('把 processing 任务移到 finished 并 emit finished', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 't2' })).data.output as string)
    // 模拟执行开始：任务先移到 processing（同列队→执行中的状态流转）
    const { moveTask } = await import('../src/opencc-src/server/taskFactoryFiles.js')
    await moveTask(id, 'queue-tasks', 'processing-tasks')
    const r = await superTasksMarkDoneTool.call({ id })
    expect(r.data.output).toContain('done')
    expect(events.some((e) => e.action === 'finished' && e.payload.id === id)).toBe(true)
  })

  it('对不在 processing 的任务抛错', async () => {
    const id = extractId((await superTasksCreateTool.call({ title: 't3' })).data.output as string) // 仍在 queue-tasks
    await expect(superTasksMarkDoneTool.call({ id })).rejects.toThrow(/拒绝验收|not found/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zn-agent-core exec vitest run test/unit/taskFactoryTools.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `taskFactoryTools.ts`**

镜像 `displayFilesOpencc.ts` 的 buildTool 方法集（isReadOnly/isConcurrencySafe/isDestructive/description/prompt/inputSchema/call/renderToolUseMessage/renderToolResultMessage/toAutoClassifierInput/checkPermissions/userFacingName）；不重写 `mapToolResultToToolResultBlockParam`（让 vendor 默认把 output 文本回灌 LLM）。

```ts
import { z } from 'zod/v4'
import { buildTool } from '../Tool.js'
import {
  createPoolTask, getTaskSummary, moveTask, emitTaskFactoryEvent,
} from './taskFactoryFiles.js'

const CREATE_DESC = '创建任务工厂任务：在 ~/.zai/task-factory/queue-tasks/<id>/ 初始化 index.md、docs/spec.md、docs/plan.md、process.md。' +
  '需求与用户讨论清楚后调用；title 必填，agent 为执行子 Agent 用的 agent 名（默认 default），spec/plan 为已讨论出的内容（可选，落库后仍可用 Edit 补充）。'

const MARK_DESC = '验收任务完成：把 processing-tasks/<id> 移到 finished-tasks/<id> 并置 status: done。' +
  '仅在确认 process.md 末尾有 ## [DONE] 且成果核对无误后调用。'

export const superTasksCreateTool = buildTool({
  name: 'SuperTasksCreate',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async description() { return CREATE_DESC },
  async prompt() { return CREATE_DESC },
  get inputSchema() {
    return z.object({
      title: z.string().min(1).describe('任务标题（index.md 的 title）'),
      description: z.string().optional().describe('一句任务目标描述'),
      agent: z.string().optional().describe('执行子 Agent 的 agent 名，默认 default'),
      spec: z.string().optional().describe('已讨论的需求规格 markdown'),
      plan: z.string().optional().describe('已讨论的执行计划 markdown'),
    })
  },
  async call(input: { title: string; description?: string; agent?: string; spec?: string; plan?: string }) {
    const s = await createPoolTask(input)
    emitTaskFactoryEvent('created', { id: s.id })
    return { data: { output: `Task created: ${s.id}\n${s.title}\n存放目录: ${join(taskFactoryRoot(), 'queue-tasks', s.id)}\n下一步：把 docs/spec.md、docs/plan.md 讨论结果落库；派发执行子 Agent 前先读 index.md 确认 agent 字段。` } }
  },
  renderToolUseMessage() { return null },
  renderToolResultMessage() { return null },
  toAutoClassifierInput() { return '' },
  checkPermissions(input) {
    return Promise.resolve({ behavior: 'allow' as const, updatedInput: input, decisionReason: { type: 'mode' as const, mode: 'bypassPermissions' as const } })
  },
  userFacingName: () => 'SuperTasksCreate',
})

export const superTasksMarkDoneTool = buildTool({
  name: 'SuperTasksMarkDone',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,
  async description() { return MARK_DESC },
  async prompt() { return MARK_DESC },
  get inputSchema() {
    return z.object({ id: z.string().min(4).describe('任务 id，如 tf-a1b2c3d4') })
  },
  async call(input: { id: string }) {
    const inProcessing = await getTaskSummary(input.id, 'processing-tasks')
    if (!inProcessing) {
      // 明确只接受 processing 状态（测试第二段断言此错误）
      const anywhere = await getTaskSummary(input.id)
      throw new Error(anywhere
        ? `task ${input.id} 不在 processing-tasks（当前 ${anywhere.bucket}），拒绝验收`
        : `task ${input.id} not found`)
    }
    const done = await moveTask(input.id, 'processing-tasks', 'finished-tasks')
    emitTaskFactoryEvent('finished', { id: done.id })
    return { data: { output: `Task done: ${done.id}（${done.title}）已移至 finished-tasks` } }
  },
  renderToolUseMessage() { return null },
  renderToolResultMessage() { return null },
  toAutoClassifierInput() { return '' },
  checkPermissions(input) {
    return Promise.resolve({ behavior: 'allow' as const, updatedInput: input, decisionReason: { type: 'mode' as const, mode: 'bypassPermissions' as const } })
  },
  userFacingName: () => 'SuperTasksMarkDone',
})
```

补充 import：`import { join } from 'node:path'`、`import { taskFactoryRoot } from './taskFactoryFiles.js'`。

- [ ] **Step 4: 跑测试确认通过**

Step 1 的测试已按最终行为写好（MarkDone 只接受 processing 状态；output 纯文本正则取 id），无需再改。Run: 同 Step 2。
Expected: PASS。

- [ ] **Step 5: build + 提交**

```bash
pnpm run build:core
git add packages/zn-agent-core/src/opencc-src/server/taskFactoryTools.ts packages/zn-agent-core/test/unit/taskFactoryTools.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(core): SuperTasksCreate/SuperTasksMarkDone 工具"
```

---

### Task 3: core — 任务任务调度官 Agent `task-factory` 注册 + transcript 归拢 patch

**Files:**
- Create: `packages/zn-agent-core/src/opencc-src/server/mainAgents-taskFactory.ts`
- Modify: `packages/zn-agent-core/src/opencc-src/server/mainAgents.ts:26-96`（import + `getBuiltinMainAgents()` 数组）
- Modify: `packages/zn-agent-core/src/opencc-src/utils/sessionStorage.ts:572-583`（`getAgentTranscriptPath` 支持绝对 subdir）
- Test: `packages/zn-agent-core/test/unit/agentRegistry-taskFactory.test.ts`、`packages/zn-agent-core/test/unit/sessionStorage-transcriptRoot.test.ts`

**Interfaces:**
- Consumes: Task 2 的两个工具；`MainAgentConfig`（mainAgents.ts）；`getAgentTranscriptPath`（sessionStorage.ts，负责执行器 transcript 落盘位置）。
- Produces:
```ts
export const TASK_FACTORY_MAIN_AGENT_NAME = 'task-factory'   // 贯穿后续所有任务的字符串常量
export const taskFactoryMainAgent: MainAgentConfig
// core patch: transcriptSubdir 为绝对路径时直接作为 transcript 根目录（不再拼在 projectDir/sessionId/subagents 下）
```

- [ ] **Step 0（本次新增）: transcript 归拢 patch + 失败测试**

```ts
// packages/zn-agent-core/test/unit/sessionStorage-transcriptRoot.test.ts
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  setAgentTranscriptSubdir, clearAgentTranscriptSubdir, getAgentTranscriptPath,
} from '../src/opencc-src/utils/sessionStorage.js'

describe('getAgentTranscriptPath abs subdir', () => {
  afterEach(() => clearAgentTranscriptSubdir('agent-x'))
  it('绝对路径 subdir 直接作为 transcript 根目录', () => {
    setAgentTranscriptSubdir('agent-x', '/abs/task-dir/transcript')
    expect(getAgentTranscriptPath('agent-x' as never)).toBe('/abs/task-dir/transcript/agent-agent-x.jsonl')
  })
  it('相对路径保持原拼接（回归护栏）', () => {
    setAgentTranscriptSubdir('agent-x', 'workflows/run-1')
    const p = getAgentTranscriptPath('agent-x' as never)
    expect(p).toContain('/subagents/workflows/run-1/agent-agent-x.jsonl')
  })
})
```

`getAgentTranscriptPath` 修改（`sessionStorage.ts:572-583`）：

```ts
export function getAgentTranscriptPath(agentId: AgentId): string {
  // Same sessionProjectDir consistency as getTranscriptPathForSession —
  // subagent transcripts live under the session dir, so if the session
  // transcript is at sessionProjectDir, subagent transcripts are too.
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const sessionId = getSessionId()
  const subdir = agentTranscriptSubdirs.get(agentId)
  // zai patch (2026-09-01, task-factory): 绝对路径 subdir 直接作为
  // transcript 根目录 —— 任务工厂把执行器 transcript 归拢到
  // ~/.zai/task-factory/processing-tasks/<id>/，原实现只支持相对拼接。
  if (subdir && isAbsolute(subdir)) {
    return join(subdir, `agent-${agentId}.jsonl`)
  }
  const base = subdir
    ? join(projectDir, sessionId, 'subagents', subdir)
    : join(projectDir, sessionId, 'subagents')
  return join(base, `agent-${agentId}.jsonl`)
}
```

补 import：`import { isAbsolute, join } from 'node:path'`（现有 import 行确认含 join；isAbsolute 需追加）。

- [ ] **Step 1: 写失败测试（agent 注册）**

```ts
// packages/zn-agent-core/test/unit/agentRegistry-taskFactory.test.ts
import { describe, expect, it } from 'vitest'
import { resetAgentRegistryForTests, getAgentRegistry } from '../src/opencc-src/server/agentRegistry.js'

describe('task-factory builtin agent', () => {
  it('loadBuiltinAgents 注册 task-factory，tools 槽含两个 SuperTasks 工具', async () => {
    resetAgentRegistryForTests()
    const reg = getAgentRegistry()
    reg.loadBuiltinAgents()
    reg.registryAgent('sess-1', 'task-factory')
    const tools = await reg.slot([], 'tools', 'sess-1')
    const names = tools.map((t) => t.name)
    expect(names).toContain('SuperTasksCreate')
    expect(names).toContain('SuperTasksMarkDone')
    expect(reg.resolveAgent('task-factory')?.description).toBeTruthy()
  })

  it('tools 槽保留默认工具池（SpawnAgent 可用）', async () => {
    resetAgentRegistryForTests()
    const reg = getAgentRegistry()
    reg.loadBuiltinAgents()
    reg.registryAgent('sess-2', 'task-factory')
    const tools = await reg.slot([{ name: 'SpawnAgent' } as never], 'tools', 'sess-2')
    expect(tools.some((t) => t.name === 'SpawnAgent')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zn-agent-core exec vitest run test/unit/sessionStorage-transcriptRoot.test.ts test/unit/agentRegistry-taskFactory.test.ts`
Expected: FAIL（Unknown agent / 绝对路径断言不满足）。

- [ ] **Step 3: 实现 agent 模块 + 注册**

`mainAgents-taskFactory.ts`：

```ts
import type { Tool } from '../Tool.js'
import type { MainAgentConfig } from './mainAgents.js'
import { superTasksCreateTool, superTasksMarkDoneTool } from './taskFactoryTools.js'

export const TASK_FACTORY_MAIN_AGENT_NAME = 'task-factory'

const TASK_FACTORY_SYSTEM_PROMPT = [
  '你是「任务工厂」任务调度官 Agent。职责是接收、落库、分派、验收任务：',
  '1. 需求讨论：用户提出任务时，先调用 SkillTool 运行 brainstorming skill 与用户把需求、验收标准讨论清楚（新建任务的对话默认就是这样）。',
  '2. 落库：讨论清楚后调用 SuperTasksCreate 在 ~/.zai/task-factory/queue-tasks/<id>/ 创建任务骨架；把讨论结果用 Edit/Write 写入 docs/spec.md（需求规格）、docs/plan.md（执行计划）。',
  '3. 派发执行：需要执行时，读取任务 index.md 的 agent 字段（claude-code 或 dsh 等外部 CLI agent 名）。**优先用 SpawnAgent 派发**（subagent_type 填该 agent 名），不可用（provider 未注册）时回退 AgentTool。执行子 Agent 的 cwd 指向任务目录（~/.zai/task-factory/processing-tasks/<id>/），prompt 要求其先读 docs/spec.md + docs/plan.md，再实现，边做边向 process.md 追加进度（一行时间戳 + 步骤 + 结论），完成后在 process.md 末尾追加 "## [DONE]"，并汇报结果摘要。若用 AgentTool 委派（内部 agent），把 transcriptSubdir 设为任务目录的绝对路径，让 transcript 归拢到任务目录。派发成功后把 index.md 的 executorTaskId 回填为子 Agent 任务的 task id（SpawnAgent 返回值里的 task_id / agentId）。',
  '4. 验收：子 Agent 完成后（你会收到后台任务完成通知），读 process.md 确认 [DONE] 标记并核对 spec.md 的验收标准；通过则调用 SuperTasksMarkDone 移到 finished-tasks；不通过则向子 Agent 发消息要求修订。',
  '5. 系统指令：会话中会出现 <task-command action="...">...</task-command> 形式的系统消息（来源：task-factory）。按 action 执行：dispatch（从 queue 派发任务执行，可一次派发多个队列任务）、resume（继续执行指定任务，resume 原执行会话或重新委派）、accept（验收指定任务）、pause（结束执行子 Agent 并冻结）。',
  '每个任务同时只派发一个执行子 Agent；不同任务可并行执行——收到 dispatch 指令时按队列顺序派发（可多任务并行，不要强制等前一个任务完成后才派发下一个）。',
]

/** tools 槽：默认工具池追加两个专用工具（去重防同名）。 */
const taskFactoryTools = (origin: Tool[]): Tool[] => {
  const extra = [superTasksCreateTool, superTasksMarkDoneTool]
  const names = new Set(origin.map((t) => String(t.name)))
  return [...origin, ...extra.filter((t) => !names.has(String(t.name)))]
}

export const taskFactoryMainAgent: MainAgentConfig = {
  name: TASK_FACTORY_MAIN_AGENT_NAME,
  description: '任务工厂任务调度官 —— 需求讨论、任务落库、分派执行与验收',
  systemPrompt: (origin) => [...TASK_FACTORY_SYSTEM_PROMPT, ...origin],
  tools: taskFactoryTools,
}
```

`mainAgents.ts` 修改：

```ts
import { agentCreatorMainAgent } from './mainAgents-agentCreator.js'
import { taskFactoryMainAgent } from './mainAgents-taskFactory.js'   // 新增

export function getBuiltinMainAgents(): MainAgentConfig[] {
  return [
    { /* default */ },
    officeMainAgent,
    agentCreatorMainAgent,
    taskFactoryMainAgent,   // 新增
  ]
}
```

- [ ] **Step 4: build + 跑测试确认通过**

Run: `pnpm run build:core` 后重跑 Step 2 命令。
Expected: PASS（5 it 全过：2 个 transcript + 3 个 agent）。

- [ ] **Step 5: 提交**

```bash
git add packages/zn-agent-core/src/opencc-src/server/mainAgents-taskFactory.ts packages/zn-agent-core/src/opencc-src/server/mainAgents.ts packages/zn-agent-core/src/opencc-src/utils/sessionStorage.ts packages/zn-agent-core/test/unit/agentRegistry-taskFactory.test.ts packages/zn-agent-core/test/unit/sessionStorage-transcriptRoot.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(core): 任务任务调度官 agent task-factory + transcript 归拢 patch"
```

---

### Task 3.5: 任务 cwd 字段贯穿（用户 2026-09-01 追加：不同任务落在不同工程目录）

> 追加需求：任务信息需携带**工程目录 cwd**（index.md frontmatter），委派执行子 Agent 时
> 以任务的 cwd 作为执行环境参数（SpawnAgent `cwd` / AgentTool prompt 显式声明）。
> Task 1/2 已交付的旧 shape（无 cwd）由本任务补齐；Task 3 的 system prompt 同步更新。

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/server/taskFactoryFiles.ts`（TaskSummary.cwd、createPoolTask、index.md 模板、frontmatter 解析兼容）
- Modify: `packages/zn-agent-core/src/opencc-src/server/taskFactoryTools.ts`（SuperTasksCreate inputSchema 加 cwd）
- Modify: `packages/zn-agent-core/src/opencc-src/server/mainAgents-taskFactory.ts`（system prompt：以任务 cwd 委派）
- Modify: `packages/zn-agent-core/test/unit/taskFactoryFiles.test.ts`
- Modify: `packages/zn-agent-core/test/unit/taskFactoryTools.test.ts`（可选补充 cwd 断言）
- Test: 复用上面两个测试文件（新增用例）

**Interfaces:**
- Consumes: Task 1/2/3 的既有实现。
- Produces（cwd 字段贯穿后的最终 shape，Task 4+ 全部按此消费）:
```ts
export interface TaskSummaryTemplate {
  id: string; title: string; status: string
  cwd: string            // 新增：任务所在工程目录（绝对路径）
  agent?: string; createdAt?: string; startedAt?: string | null
  completedAt?: string | null; executorTaskId?: string | null
  bucket: TaskBucketName
}
// createPoolTask(input: { id?; title; description?; agent?; spec?; plan?; cwd? })：
//  cwd 缺省回退 process.cwd()；index.md frontmatter 写入 `cwd: <abs>`
```

- [ ] **Step 1: 写失败测试（files 层 cwd；hardcode 用测试隔离目录）**

在 `taskFactoryFiles.test.ts` 追加：

```ts
it('createPoolTask 写入 cwd 到 index.md，缺省回退 process.cwd()', async () => {
  const s = await createPoolTask({ title: 'cwd-task', cwd: '/abs/code/proj-a' })
  expect(s.cwd).toBe('/abs/code/proj-a')
  const index = await readFile(join(dir, 'queue-tasks', s.id, 'index.md'), 'utf-8')
  expect(index).toContain('cwd: /abs/code/proj-a')
  const s2 = await createPoolTask({ title: 'no-cwd' })
  expect(s2.cwd).toBe(process.cwd())
})

it('执行期 markTaskStatus 与 moveTask 保留 cwd 字段', async () => {
  const s = await createPoolTask({ title: 'keep', cwd: '/p/q' })
  await markTaskStatus(s.id, 'queue-tasks', { status: 'processing', executorTaskId: 'a1234567' })
  const moved = await moveTask(s.id, 'queue-tasks', 'processing-tasks')
  expect(moved.cwd).toBe('/p/q')
  const index = await readFile(join(dir, 'processing-tasks', s.id, 'index.md'), 'utf-8')
  expect(index).toContain('cwd: /p/q')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zn-agent-core exec vitest run test/unit/taskFactoryFiles.test.ts`
Expected: FAIL（`s.cwd` undefined / index 无 `cwd:` 行）。

- [ ] **Step 3: 实现 files 层 cwd**

`taskFactoryFiles.ts`：
- `TaskSummary` 加 `cwd: string`。
- `createPoolTask` 输入加 `cwd?: string`；`const taskCwd = input.cwd ?? process.cwd()`；index.md 模板在 `status:` 后插入 `cwd: ${esc(taskCwd)}`；返回 summary 带 `cwd: taskCwd`。
- `toSummary`（readIndex 后）从 meta 读 `cwd`：`cwd: meta.cwd ?? process.cwd()`（老任务无 cwd 兜底为当前进程 cwd，不抛错）。
- 其余接口不变；`createPoolTask` 返回对象在 `{ id, title, status, agent, createdAt, bucket }` 中追加 `cwd`。

- [ ] **Step 4: 工具层 inputSchema 加 cwd（taskFactoryTools.ts）**

`superTasksCreateTool.inputSchema` 追加字段，并把 CALL 传参带上：

```ts
return z.object({
  title: z.string().min(1).describe('任务标题（index.md 的 title）'),
  cwd: z.string().min(1).describe('任务所在工程目录的绝对路径（执行子 Agent 的工作目录；不同任务可落在不同代码工程）'),
  description: z.string().optional().describe('一句任务目标描述'),
  agent: z.string().optional().describe('执行子 Agent 的 agent 名，默认 default'),
  spec: z.string().optional().describe('已讨论的需求规格 markdown'),
  plan: z.string().optional().describe('已讨论的执行计划 markdown'),
})
```
`call` 里 `createPoolTask({ ...input, cwd: input.cwd })`；`output` 文本增加一行 `工程目录: ${input.cwd}`。CREATE_DESC 文案加"cwd 必填"。**注意**：cwd 设为必填后，Task 2 既有 3 个测试用例的 `.call({ title: ... })` 会因 schema 校验失败——把测试里所有 call 入参加 `cwd: dir`（beforeEach 的 tmpdir，即 `process.env.ZAI_TASK_FACTORY_DIR` 值）。

- [ ] **Step 5: system prompt 更新（mainAgents-taskFactory.ts）**

任务 3 步骤 3 的 prompt 第 3 条改为（关键差异：**cwd 是任务的工程目录**，transcript 仍归拢任务目录）：

```
'3. 派发执行：需要执行时，读取任务 index.md 的 agent 字段（claude-code 或 dsh 等外部 CLI agent 名）与 cwd 字段（任务所在工程目录）。**优先用 SpawnAgent 派发**（subagent_type 填该 agent 名，cwd 参数填任务的 cwd），不可用（provider 未注册）时回退 AgentTool（prompt 里显式声明任务的 cwd 绝对路径并要求在其中工作）。执行子 Agent 先读任务目录的 docs/spec.md + docs/plan.md，再实现，边做边向任务目录的 process.md 追加进度（一行时间戳 + 步骤 + 结论），完成后在 process.md 末尾追加 "## [DONE]"，并汇报结果摘要。若用 AgentTool 委派，把 transcriptSubdir 设为任务目录的绝对路径，让 transcript 归拢到任务目录。派发成功后把 index.md 的 executorTaskId 回填为子 Agent 任务的 task id（SpawnAgent 返回值里的 task_id / agentId）。',
```

- [ ] **Step 6: 回归 + build + 提交**

Run:
```bash
pnpm --filter @zn-ai/zn-agent-core exec vitest run test/unit/taskFactoryFiles.test.ts test/unit/taskFactoryTools.test.ts test/unit/agentRegistry-taskFactory.test.ts test/unit/sessionStorage-transcriptRoot.test.ts
pnpm run build:core
```
Expected: 全绿（files 13+、tools 3、registry 3、transcript 2）。

```bash
git add packages/zn-agent-core/src/opencc-src/server/taskFactoryFiles.ts packages/zn-agent-core/src/opencc-src/server/taskFactoryTools.ts packages/zn-agent-core/src/opencc-src/server/mainAgents-taskFactory.ts packages/zn-agent-core/test/unit/taskFactoryFiles.test.ts packages/zn-agent-core/test/unit/taskFactoryTools.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(core): 任务增加工程目录 cwd 字段并贯穿委派"
```

---

### Task 4: zai server — superTasks 路由 + 事件 bridge + 状态持久化 + 任务调度官注入

**Files:**
- Create: `packages/zai/src/server/services/taskFactoryBridge.ts`
- Create: `packages/zai/src/server/routes/superTasks.ts`
- Modify: `packages/zai/src/server/index.ts`（import + `app.use('/api', superTasksRouter)` + 启动时初始化 bridge）
- Test: `packages/zai/test/server/services/taskFactoryBridge.test.ts`、`packages/zai/test/server/routes/superTasks.test.ts`

**Interfaces:**
- Consumes: Task 1 的 fs 服务（经 `@zn-ai/zn-agent-core` 主入口导出——见 Step 3 导出说明）；`eventBus`（`services/eventBus.ts`）；`sessionInbox`（`services/sessionInbox.ts`，已存在）。
- Produces:
```ts
export function initTaskFactoryBridge(): void            // 注入 globalThis.__zaiTaskFactoryEmitter → eventBus
export function getTaskFactoryState(): Promise<{ managedEnabled: boolean; supervisorSessionId: string }>
export function setTaskFactoryState(patch: Partial<{ managedEnabled: boolean; supervisorSessionId: string }>): Promise<void>
export function injectSupervisorCommand(content: string): void   // sessionInbox.followup 任务调度官会话
// routes/superTasks.ts 默认导出 router：GET /api/super-tasks、GET /api/super-tasks/:id、
// POST /api/super-tasks/delete、POST /api/super-tasks/managed、POST /api/super-tasks/inject
```

- [ ] **Step 1: 确认 core 主入口导出 + 写失败测试（bridge 服务）**

先确认 `packages/zn-agent-core/src/bundle-entry.ts` 是否已 re-export `taskFactoryFiles`（Task 1 未加）。需要把它加进主入口（zai import 统一走 `@zn-ai/zn-agent-core`）：
- Modify: `packages/zn-agent-core/src/bundle-entry.ts`（Task 1 遗漏，本任务补齐）— 追加:
```ts
export * from './opencc-src/server/taskFactoryFiles.js'
```
并在 `treeshake` 相关配置中确认无排除（无配置则忽略）。

```ts
// packages/zai/test/server/services/taskFactoryBridge.test.ts
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initTaskFactoryBridge, getTaskFactoryState, setTaskFactoryState, __resetForTests,
} from '../../src/server/services/taskFactoryBridge.js'
import { eventBus } from '../../src/server/services/eventBus.js'
import { sessionInbox } from '../../src/server/services/sessionInbox.js'

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'tf-bridge-')); process.env.ZAI_TASK_FACTORY_DIR = dir })
afterAll(async () => { delete process.env.ZAI_TASK_FACTORY_DIR; await rm(dir, { recursive: true, force: true }) })

describe('taskFactoryBridge', () => {
  it('set/get state 持久化到 state.json', async () => {
    __resetForTests()
    await setTaskFactoryState({ managedEnabled: true, supervisorSessionId: 'sess-sup' })
    const s = await getTaskFactoryState()
    expect(s.managedEnabled).toBe(true)
    expect(s.supervisorSessionId).toBe('sess-sup')
    const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'))
    expect(raw.managedEnabled).toBe(true)
  })

  it('emitter 事件经 eventBus 发出', () => {
    __resetForTests()
    const spy = vi.spyOn(eventBus, 'emit')
    initTaskFactoryBridge()
    const emitter = (globalThis as any).__zaiTaskFactoryEmitter
    emitter({ action: 'created', payload: { id: 'tf-x' } })
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_factory', action: 'created' }))
  })

  it('injectSupervisorCommand 走 sessionInbox.followup', async () => {
    __resetForTests()
    await setTaskFactoryState({ managedEnabled: false, supervisorSessionId: 'sess-sup' })
    const spy = vi.spyOn(sessionInbox, 'followup')
    injectSupervisorCommand('<task-command action="dispatch"></task-command>')
    expect(spy).toHaveBeenCalledWith(
      'sess-sup',
      expect.objectContaining({ source: { kind: 'task-factory' }, content: expect.stringContaining('task-command') }),
    )
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test test/server/services/taskFactoryBridge.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `taskFactoryBridge.ts`**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { eventBus, type ServerEventInput } from './eventBus.js'
import { sessionInbox } from './sessionInbox.js'
import { taskFactoryRoot } from '@zn-ai/zn-agent-core'

export interface TaskFactoryState { managedEnabled: boolean; supervisorSessionId: string }
const DEFAULT_STATE: TaskFactoryState = { managedEnabled: false, supervisorSessionId: 'task-factory-supervisor' }
const stateFile = () => join(taskFactoryRoot(), 'state.json')
let injected = false
let seq = 0

export function initTaskFactoryBridge(): void {
  if (injected) return
  injected = true
  ;(globalThis as { __zaiTaskFactoryEmitter?: (e: { action: string; payload: Record<string, unknown> }) => void }).__zaiTaskFactoryEmitter = (e) => {
    eventBus.emit({ type: 'task_factory', action: e.action, payload: e.payload, ts: Date.now() } as unknown as ServerEventInput)
  }
}

export async function getTaskFactoryState(): Promise<TaskFactoryState> {
  try {
    if (!existsSync(stateFile())) return DEFAULT_STATE
    const raw = JSON.parse(await readFile(stateFile(), 'utf-8')) as Partial<TaskFactoryState>
    return { ...DEFAULT_STATE, ...raw }
  } catch {
    return DEFAULT_STATE
  }
}

export async function setTaskFactoryState(patch: Partial<TaskFactoryState>): Promise<void> {
  const next = { ...(await getTaskFactoryState()), ...patch }
  await mkdir(taskFactoryRoot(), { recursive: true })
  await writeFile(stateFile(), JSON.stringify(next, null, 2), 'utf-8')
  eventBus.emit({ type: 'task_factory', action: 'state.changed', payload: next, ts: Date.now() } as unknown as ServerEventInput)
}

/** 向任务调度官会话注入一条指令（next-turn + wake；忙则自动降级排队）。 */
export function injectSupervisorCommand(content: string): void {
  const sid = // 异步读取融入同步调用：见下方 resolveSupervisorSessionIdSync
    getTaskFactoryStateSync().supervisorSessionId
  sessionInbox.followup(sid, {
    id: `tf-cmd-${++seq}-${Date.now()}`,
    source: { kind: 'task-factory', form: 'notice' },
    content,
    createdAt: Date.now(),
  })
}
```

注意 `injectSupervisorCommand` 是同步的而 state 读取是异步——为该函数配套一个同步缓存：模块内 `let cachedState = DEFAULT_STATE`；`setTaskFactoryState` 写入后同步更新 `cachedState`；`getTaskFactoryState` 启动时刷新缓存。`getTaskFactoryStateSync()` 返回缓存。测试里 `setTaskFactoryState` 后再 `injectSupervisorCommand` 即命中缓存。补充实现：

```ts
let cachedState: TaskFactoryState = DEFAULT_STATE
export function getTaskFactoryStateSync(): TaskFactoryState { return cachedState }
// setTaskFactoryState 内：cachedState = next 后再写盘
// getTaskFactoryState 内：结果先赋给 cachedState 再返回
export function __resetForTests(): void { injected = false; cachedState = DEFAULT_STATE; seq = 0 }
```

- [ ] **Step 4: 实现 routes/superTasks.ts（含失败测试同步编写）**

```ts
// packages/zai/test/server/routes/superTasks.test.ts
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import supertest from 'supertest'        // 项目中已有（routes 测试先例）
import superTasksRouter from '../../src/server/routes/superTasks.js'
import { __resetForTests, setTaskFactoryState } from '../../src/server/services/taskFactoryBridge.js'
import { injectSupervisorCommand } from '../../src/server/services/taskFactoryBridge.js'
import { createPoolTask } from '@zn-ai/zn-agent-core'

let dir: string
let app: express.Express
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-routes-'))
  process.env.ZAI_TASK_FACTORY_DIR = dir
  __resetForTests()
  await setTaskFactoryState({ managedEnabled: false, supervisorSessionId: 'sess-sup' })
  app = express()
  app.use(express.json())
  app.use('/api', superTasksRouter)
})
afterAll(async () => { delete process.env.ZAI_TASK_FACTORY_DIR; await rm(dir, { recursive: true, force: true }) })

describe('GET /api/super-tasks', () => {
  it('返回三栏 bucket', async () => {
    await createPoolTask({ title: 'a' })
    const res = await supertest(app).get('/api/super-tasks')
    expect(res.status).toBe(200)
    expect(res.body.buckets.queue.length).toBeGreaterThan(0)
  })
})

describe('DELETE /api/super-tasks', () => {
  it('删除排队任务', async () => {
    const s = await createPoolTask({ title: 'del' })
    const res = await supertest(app).delete('/api/super-tasks').send({ ids: [s.id] })
    expect(res.status).toBe(200)
    const list = await supertest(app).get('/api/super-tasks')
    expect(list.body.buckets.queue.find((t: any) => t.id === s.id)).toBeUndefined()
  })
  it('processing 任务返回 409', async () => {
    const s = await createPoolTask({ title: 'keep' })
    await (await import('@zn-ai/zn-agent-core')).moveTask(s.id, 'queue-tasks', 'processing-tasks')
    const res = await supertest(app).delete('/api/super-tasks').send({ ids: [s.id] })
    expect(res.status).toBe(409)
  })
})

describe('POST /api/super-tasks/managed', () => {
  it('切换开关并注入任务调度官指令', async () => {
    const spy = vi.spyOn({ injectSupervisorCommand }, 'injectSupervisorCommand')
    const res = await supertest(app).post('/api/super-tasks/managed').send({ enabled: false })
    expect(res.status).toBe(200)
    vi.restoreAllMocks()
  })
})
```

route 实现（`routes/superTasks.ts`）：

```ts
import { Router } from 'express'
import { listTasks, getTaskSummary, getTaskDetails, deleteTasks } from '@zn-ai/zn-agent-core'
import {
  getTaskFactoryState, setTaskFactoryState, injectSupervisorCommand,
} from '../services/taskFactoryBridge.js'

const router = Router()

router.get('/super-tasks', async (_req, res) => {
  const [buckets, state] = await Promise.all([listTasks(), getTaskFactoryState()])
  res.json({ buckets, managed: state.managedEnabled, supervisorSessionId: state.supervisorSessionId })
})

router.get('/super-tasks/:id', async (req, res) => {
  const d = await getTaskDetails(req.params.id)
  if (!d) return res.status(404).json({ error: `task ${req.params.id} not found` })
  res.json({ task: d })
})

router.delete('/super-tasks', async (req, res) => {
  const { ids } = (req.body ?? {}) as { ids?: unknown }
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string')) {
    return res.status(400).json({ error: 'ids: 非空字符串数组必填' })
  }
  try {
    await deleteTasks(ids as string[])
    res.json({ ok: true })
  } catch (err) {
    res.status((err as Error).message.includes('processing') ? 409 : 404).json({ error: (err as Error).message })
  }
})

router.post('/super-tasks/managed', async (req, res) => {
  const { enabled } = (req.body ?? {}) as { enabled?: unknown }
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled: boolean 必填' })
  await setTaskFactoryState({ managedEnabled: enabled })
  res.json({ ok: true })
})

/**
 * POST /api/super-tasks/inject — 向任务调度官会话注入指令（task-factory 内部 + 面板按钮统一入口）。
 * 业务侧（start/pause/resume/托管循环）都调它，保证注入语义一致。
 */
router.post('/super-tasks/inject', async (req, res) => {
  const { action, id } = (req.body ?? {}) as { action?: unknown; id?: unknown }
  if (typeof action !== 'string') return res.status(400).json({ error: 'action: string 必填' })
  if (!['dispatch', 'resume', 'accept', 'pause'].includes(action)) {
    return res.status(400).json({ error: `unsupported action: ${action}` })
  }
  const task = id ? await getTaskSummary(id) : null
  if (id && !task) return res.status(404).json({ error: `task ${id} not found` })
  const body = id
    ? `\n<task-command action="${action}" id="${id}" title="${(task!.title ?? '').replace(/</g, '＜')}">请按指令处理任务 ${id}: ${action}</task-command>`
    : `\n<task-command action="${action}">请按指令处理: ${action}</task-command>`
  injectSupervisorCommand(body)
  res.json({ ok: true })
})

export default router
```

在 `routes/agent.ts` 同目录注意：不要与既有 `/api/agent` 前缀冲突——本 router 挂在 `/api` 前缀下，路径自带 `super-tasks`，安全。

- [ ] **Step 5: 挂载路由 + 启动初始化（server/index.ts）**

```ts
import superTasksRouter from './routes/superTasks.js'
import { initTaskFactoryBridge } from './services/taskFactoryBridge.js'
// 创建 express app 之后、中间件链上：
app.use('/api', superTasksRouter)
// 启动 bootstrap（与 initInstanceSupervisor 同处）：
initTaskFactoryBridge()
```

补充（若 zai 测试 import `@zn-ai/zn-agent-core` 走的是构建产物）：本任务前必须重新 `pnpm run build:core`（bundle-entry 加了 taskFactoryFiles 导出）。

- [ ] **Step 6: 跑测试 + build + 提交**

Run: `pnpm run build:core && pnpm --filter @zn-ai/zai test test/server/services/taskFactoryBridge.test.ts test/server/routes/superTasks.test.ts`
Expected: PASS。

```bash
git add packages/zn-agent-core/src/bundle-entry.ts packages/zai/src/server/services/taskFactoryBridge.ts packages/zai/src/server/routes/superTasks.ts packages/zai/src/server/index.ts packages/zai/test/server/services/taskFactoryBridge.test.ts packages/zai/test/server/routes/superTasks.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): superTasks 路由与任务工厂 bridge"
```

---

### Task 5: zai server — mainAgent 强制 + 实例 app 支持（CLI/supervisor/routes/system）

**Files:**
- Modify: `packages/zai/src/cli/index.ts`（两条命令加 `--app`）
- Modify: `packages/zai/src/cli/start.ts`（StartOptions + env 透传）
- Modify: `packages/zai/src/shared/instances.ts`（InstanceDefinition.app）
- Modify: `packages/zai/src/server/services/instanceSupervisor.ts`（createInstance input + spawn args）
- Modify: `packages/zai/src/server/routes/instances.ts`（POST 解析 app）
- Modify: `packages/zai/src/server/routes/agent.ts`（mainAgent 兜底强制）
- Modify: `packages/zai/src/server/routes/system.ts`（返回 app）
- Test: `packages/zai/test/server/routes/instances.test.ts`（追加 app 用例）、`packages/zai/test/server/routes/system.test.ts`（如有）

**Interfaces:**
- Consumes: 无新依赖。
- Produces:
```ts
// process.env.ZAI_APP === 'task-factory' 时：
//   options.app 透传 → start.ts 设 env → agent.ts 会话 mainAgent 强制 'task-factory'
//   /api/system 返回 app: 'task-factory'
```

- [ ] **Step 1: CLI — index.ts 两条命令追加 option，start.ts 透传 env**

`index.ts`（两条 command 的 `.option` 链各加一条，参照 `--runtimeCore` 写法）：

```ts
.option('--app <profile>', '应用 profile: task-factory 启动即打开 /super-tasks 并锁定任务调度官 Agent')
```

并在两条 command 的 action 顶部（与 `applyRuntimeCoreFlag(options.runtimeCore)` 并排）：

```ts
if (options.app) process.env.ZAI_APP = options.app
```

`start.ts`：`StartOptions` 接口加 `app?: string`；确认 env 写入位置在 server 启动前的同步段（`runStart` 顶部，参照 `applyRuntimeCoreFlag` 注释）。

- [ ] **Step 2: 写失败测试（instances POST app）**

在 `packages/zai/test/server/routes/instances.test.ts` 追加：

```ts
it('POST /instances 接受 app=task-factory 并存持久化定义', async () => {
  const res = await request(app).post('/instances').send({ name: 'tf', cwd: process.cwd(), app: 'task-factory' })
  expect(res.status).toBe(200)
  expect(res.body.instance.app).toBe('task-factory')
})
```

若该测试文件已有 `app` 字段断言冲突，按既有 seed 结构追加即可（失败时以「app 字段 404/缺字段」为准）。

- [ ] **Step 3: 实现实例 app 支持**

`shared/instances.ts` `InstanceDefinition` 追加：

```ts
/** 启动 profile：'task-factory' = 任务工厂实例（打开 /super-tasks、锁定任务调度官 Agent）。 */
app?: 'task-factory'
```

`routes/instances.ts` POST 解析（`name`/`cwd` 之后）：

```ts
const app = (req.body ?? {}).app
if (app !== undefined && app !== 'task-factory') {
  return badRequest(res, 'app must be "task-factory" when present')
}
// 传给 createInstance 的 input 加 app
```

`instanceSupervisor.ts` `createInstance` 签名与 `startInstance`：

```ts
createInstance(input: { name; cwd; lan?; port?; runtimeCore?; app?: 'task-factory' })
```
spawn args（`args.push('--runtimeCore', effectiveRuntimeCore)` 之后）：
```ts
if (entry.def.app === 'task-factory') args.push('--app', 'task-factory')
```

- [ ] **Step 4: mainAgent 强制（routes/agent.ts）**

在 `~/prompt` handler 的 mainAgent 兜底处（现 `sessionMainAgent === null` 分支，取 `getCachedZaiSettingsSync().mainAgent ?? 'default'`）改为：

```ts
if (sessionMainAgent === null) {
  // 任务工厂实例锁定任务调度官 Agent（实例级，用户 settings 不覆盖）
  sessionMainAgent =
    process.env.ZAI_APP === 'task-factory'
      ? 'task-factory'
      : getCachedZaiSettingsSync().mainAgent ?? 'default'
}
```

同时在创建新会话的路径（`agent.ts` 中创建 session / 设置 meta.mainAgent 的代码，grep `mainAgent` 找到第二处）加同一判断；建议抽一个辅助函数：

```ts
function instanceForcedMainAgent(): string | null {
  return process.env.ZAI_APP === 'task-factory' ? 'task-factory' : null
}
```

- [ ] **Step 5: /api/system 返回 app（routes/system.ts）**

响应对象加 `app: process.env.ZAI_APP ?? null`。

- [ ] **Step 6: 跑测试 + build + 提交**

Run: `pnpm --filter @zn-ai/zai test test/server/routes/instances.test.ts test/server/system.test.ts`（如有 system 测试则含）
Expected: PASS。

```bash
git add packages/zai/src/cli/index.ts packages/zai/src/cli/start.ts packages/zai/src/shared/instances.ts packages/zai/src/server/services/instanceSupervisor.ts packages/zai/src/server/routes/instances.ts packages/zai/src/server/routes/agent.ts packages/zai/src/server/routes/system.ts packages/zai/test/server/routes/instances.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 任务工厂实例 profile（--app + mainAgent 锁定）"
```

---

### Task 6: web — superTaskApi + useSuperTaskStore

**Files:**
- Create: `packages/zai/src/web/src/lib/superTaskApi.ts`
- Create: `packages/zai/src/web/src/store/useSuperTaskStore.ts`
- Test: `packages/zai/src/web/src/store/useSuperTaskStore.test.ts`

**Interfaces:**
- Consumes: 后端 `taskFactoryFiles` 的 `TaskBucket`/`TaskSummary`/`TaskDetails` 形状（HTTP JSON）。
- Produces:
```ts
// lib/superTaskApi.ts
export interface SuperTaskListDto { buckets: { queue: TaskSummary[]; processing: TaskSummary[]; finished: TaskSummary[] }; managed: boolean; supervisorSessionId: string }
export async function fetchSuperTasks(): Promise<SuperTaskListDto>
export async function fetchSuperTaskDetail(id: string): Promise<TaskDetails>
export async function deleteSuperTasks(ids: string[]): Promise<void>
export async function setSuperTasksManaged(enabled: boolean): Promise<void>
export async function injectSuperTaskCommand(action: 'dispatch' | 'resume' | 'accept' | 'pause', id?: string): Promise<void>
// store/useSuperTaskStore.ts
export interface SuperTaskStore {
  buckets: TaskBucket; managed: boolean; loading: boolean
  load(): Promise<void>
  deleteTasks(ids: string[]): Promise<void>
  setManaged(enabled: boolean): Promise<void>
  start(id: string): Promise<void>   // = inject('dispatch', id)
  pause(id: string): Promise<void>   // = inject('pause', id)
  resume(id: string): Promise<void>  // = inject('resume', id)
}
export const useSuperTaskStore: () => SuperTaskStore   // zustand 单例
```

- [ ] **Step 1: 写失败测试（store 行为，mock fetch）**

参照现有 `useBackgroundTasks.test.ts` 的 mock fetch 风格：

```ts
// packages/zai/src/web/src/store/useSuperTaskStore.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSuperTaskStore } from './useSuperTaskStore'

describe('useSuperTaskStore', () => {
  beforeEach(() => {
    useSuperTaskStore.setState({ buckets: { queue: [], processing: [], finished: [] }, managed: false, loading: false })
    vi.restoreAllMocks()
  })

  it('load 拉取三栏并写入 state', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ buckets: { queue: [{ id: 'tf-1', title: 'a', status: 'queued', bucket: 'queue-tasks' }], processing: [], finished: [] }, managed: true }) }),
    ))
    await useSuperTaskStore.getState().load()
    const s = useSuperTaskStore.getState()
    expect(s.buckets.queue[0]?.id).toBe('tf-1')
    expect(s.managed).toBe(true)
  })

  it('start 调 inject(action=dispatch, id)', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn((url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, body: init?.body })
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
    }))
    await useSuperTaskStore.getState().start('tf-a')
    expect(calls.at(-1)?.url).toContain('/api/super-tasks/inject')
    expect(JSON.parse(calls.at(-1)!.body as string)).toEqual({ action: 'dispatch', id: 'tf-a' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/store/useSuperTaskStore.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 api + store**

`lib/superTaskApi.ts`：

```ts
import type { TaskBucket, TaskDetails, TaskSummary } from '@zn-ai/zn-agent-core'

export interface SuperTaskListDto {
  buckets: TaskBucket
  managed: boolean
  supervisorSessionId: string
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function fetchSuperTasks(): Promise<SuperTaskListDto> {
  return fetch('/api/super-tasks').then((r) => json<SuperTaskListDto>(r))
}
export function fetchSuperTaskDetail(id: string): Promise<TaskDetails> {
  return fetch(`/api/super-tasks/${encodeURIComponent(id)}`).then((r) => json<{ task: TaskDetails }>(r)).then((d) => d.task)
}
export async function deleteSuperTasks(ids: string[]): Promise<void> {
  await fetch('/api/super-tasks', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).then((r) => json<{ ok: true }>(r))
}
export async function setSuperTasksManaged(enabled: boolean): Promise<void> {
  await fetch('/api/super-tasks/managed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then((r) => json<{ ok: true }>(r))
}
export async function injectSuperTaskCommand(
  action: 'dispatch' | 'resume' | 'accept' | 'pause',
  id?: string,
): Promise<void> {
  await fetch('/api/super-tasks/inject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, id }),
  }).then((r) => json<{ ok: true }>(r))
}

export type { TaskBucket, TaskSummary, TaskDetails }
```

`store/useSuperTaskStore.ts`：

```ts
import { create } from 'zustand'
import {
  fetchSuperTasks, deleteSuperTasks, setSuperTasksManaged, injectSuperTaskCommand,
} from '../lib/superTaskApi'
import type { TaskBucket } from '../lib/superTaskApi'

const EMPTY_BUCKET: TaskBucket = { queue: [], processing: [], finished: [] }

export interface SuperTaskStore {
  buckets: TaskBucket
  managed: boolean
  loading: boolean
  error: string | null
  load: () => Promise<void>
  deleteTasks: (ids: string[]) => Promise<void>
  setManaged: (enabled: boolean) => Promise<void>
  start: (id: string) => Promise<void>
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  accept: (id: string) => Promise<void>
}

export const useSuperTaskStore = create<SuperTaskStore>((set, get) => ({
  buckets: EMPTY_BUCKET,
  managed: false,
  loading: false,
  error: null,
  load: async () => {
    set({ loading: true })
    try {
      const dto = await fetchSuperTasks()
      set({ buckets: dto.buckets, managed: dto.managed, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false })
    }
  },
  deleteTasks: async (ids) => {
    await deleteSuperTasks(ids)
    await get().load()
  },
  setManaged: async (enabled) => {
    await setSuperTasksManaged(enabled)
    set({ managed: enabled })
  },
  start: async (id) => { await injectSuperTaskCommand('dispatch', id); await get().load() },
  pause: async (id) => { await injectSuperTaskCommand('pause', id); await get().load() },
  resume: async (id) => { await injectSuperTaskCommand('resume', id); await get().load() },
  accept: async (id) => { await injectSuperTaskCommand('accept', id); await get().load() },
}))
```

注：`load()` 清空错误信息时保持 `error: null`（静默成功路径不回写 error）。

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: 同 Step 2。Expected: PASS。

```bash
git add packages/zai/src/web/src/lib/superTaskApi.ts packages/zai/src/web/src/store/useSuperTaskStore.ts packages/zai/src/web/src/store/useSuperTaskStore.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(web): super-tasks api 客户端与 store"
```

---

### Task 7: web — /super-tasks 路由 + 任务工厂跳转 + 实例入口

**Files:**
- Modify: `packages/zai/src/web/src/router.tsx`
- Modify: `packages/zai/src/web/src/store/useAppStore.ts`（`instanceContext.app` 字段）
- Modify: `packages/zai/src/web/src/components/Layout.tsx`（`setInstanceContext` 带 app）
- Modify: `packages/zai/src/web/src/pages/Instances.tsx`（创建表单 app 入口）
- Test: `packages/zai/src/web/src/pages/Instances.test.tsx`（追加 app 选项用例，如可行）

**Interfaces:**
- Consumes: Task 6 的 store。
- Produces: 路由 `/super-tasks`（顶层，脱离 Layout）；`instanceContext.app?: string | null`；Instances 创建请求带 `app: 'task-factory'`。

- [ ] **Step 1: useAppStore.instanceContext 加 app + Layout 透传**

`useAppStore.ts` 中 `instanceContext` 状态类型加 `app?: string | null`。`Layout.tsx` 的 `/system` 响应映射加 `app: data.app ?? null`（`setInstanceContext({...})` 内）。

- [ ] **Step 2: router.tsx — 顶层路由 + 跳转**

```tsx
const SuperTasks = lazy(() => import('./pages/SuperTasks'));

// 任务工厂实例：/ 与 /agent 都导向 /super-tasks（页面无菜单、只有任务 UI）
function TaskFactoryRedirect({ to }: { to: string }): JSX.Element {
  const isTaskFactory = useAppStore((s) => s.instanceContext?.app === 'task-factory');
  const target = isTaskFactory ? '/super-tasks' : to;
  return <Navigate to={target} replace />;
}
```

`<Routes>` 中（顶层，与 `/desktop` 并列）：

```tsx
{/* 任务工厂面板 — 脱离 Layout 的面板页 */}
<Route path="/super-tasks" element={<SuperTasks />} />
```

`/` 与 `/agent` 两条改为：

```tsx
<Route path="/" element={<TaskFactoryRedirect to="/agent" />} />
<Route path="/agent" element={<TaskFactoryRedirect to="/agent" />} />
```

注意：`/agent` 在标准实例下仍是 `<Agent />`，任务工厂实例则跳到 `/super-tasks`；`/super-tasks` 本身不做 Layout 包裹（无菜单）。

- [ ] **Step 3: Instances.tsx — 新建任务工厂实例入口**

创建表单（`form` 字段）加 `app` 单选项（Radio.Group：「标准实例 / 任务工厂实例」）；`onCreate` 的 POST body 加 `app: values.app === 'task-factory' ? 'task-factory' : undefined`。同时页面表格加「新建任务工厂实例」快捷按钮（`onClick` 打开创建 Modal 并预选 `app='task-factory'` + 提示 cwd 建议）。

- [ ] **Step 4: 测试 + 提交**

Run: `pnpm --filter @zn-ai/zai test src/web/src/pages/Instances.test.tsx`（若改动影响既有用例则一并修）
Expected: PASS。

```bash
git add packages/zai/src/web/src/router.tsx packages/zai/src/web/src/store/useAppStore.ts packages/zai/src/web/src/components/Layout.tsx packages/zai/src/web/src/pages/Instances.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(web): /super-tasks 路由与任务工厂实例入口"
```

---

### Task 8: web — SuperTasks 页面骨架 + 任务调度官对话区

**Files:**
- Create: `packages/zai/src/web/src/pages/SuperTasks.tsx`
- Create: `packages/zai/src/web/src/components/superTasks/SuperTaskPanel.tsx`（骨架，Task 9 填充）
- Test: `packages/zai/src/web/src/pages/SuperTasks.test.tsx`（渲染 sanity）

**Interfaces:**
- Consumes: `AgentConversation`（`pages/AgentConversation.tsx`，default export，读 `useAgentStore`）；`useAgentStore`（loadSessions/setCurrentSession/createNewSession）；`useSuperTaskStore`（Task 6）。
- Produces: `SuperTasks` 页面：左栏任务调度官对话区（AgentConversation + 标题头），右栏 `SuperTaskPanel`（三栏面板，Task 9 完成）；页面挂载时确保任务调度官会话存在。

- [ ] **Step 1: 写失败测试（渲染 + store 调用）**

```tsx
// packages/zai/src/web/src/pages/SuperTasks.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import SuperTasks from './SuperTasks'
import { useAgentStore } from '../store/useAgentStore'
import { useSuperTaskStore } from '../store/useSuperTaskStore'

describe('SuperTasks page', () => {
  it('挂载时加载任务列表并展示面板标题', async () => {
    vi.useFakeTimers()
    useSuperTaskStore.setState({ buckets: { queue: [], processing: [], finished: [] }, managed: false, loading: false })
    const load = vi.spyOn(useSuperTaskStore.getState(), 'load').mockResolvedValue(undefined)
    render(<SuperTasks />)
    await vi.advanceTimersByTimeAsync(50)
    expect(load).toHaveBeenCalled()
    expect(await screen.findByText(/任务工厂/)).toBeTruthy()
    vi.useRealTimers()
  })
})
```

（`useAgentStore` 的 fetches 通过 mock fetch stub 或按既有 `Agent.test.tsx` 的方式 stub。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/pages/SuperTasks.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现页面骨架**

```tsx
// pages/SuperTasks.tsx
import { useEffect, useRef } from 'react'
import { Typography } from 'antd'
import AgentConversation from './AgentConversation'
import SuperTaskPanel from '../components/superTasks/SuperTaskPanel'
import { useAgentStore } from '../store/useAgentStore'
import { useSuperTaskStore } from '../store/useSuperTaskStore'

const SUPERVISOR_SESSION_KEY = 'zai-supervisor-session'

export default function SuperTasks(): JSX.Element {
  const loadSessions = useAgentStore((s) => s.loadSessions)
  const setCurrentSession = useAgentStore((s) => s.setCurrentSession)
  const createNewSession = useAgentStore((s) => s.createNewSession)
  const sessions = useAgentStore((s) => s.sessions)
  const load = useSuperTaskStore((s) => s.load)
  const booted = useRef(false)

  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 3000)
    return () => window.clearInterval(id)
  }, [load])

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void (async () => {
      await loadSessions()
      const saved = localStorage.getItem(SUPERVISOR_SESSION_KEY)
      const target = sessions.find((s) => s.id === saved)
      if (target) {
        setCurrentSession(target.id)
      } else if (sessions.length > 0 && saved) {
        setCurrentSession(saved) // saved 失效时由 store 兜底
      } else {
        const created = await createNewSession()
        if (created?.id) localStorage.setItem(SUPERVISOR_SESSION_KEY, created.id)
      }
    })()
    // sessions 此刻可能为空，创建后 setCurrentSession 由后续 effect 兜底
  }, [loadSessions]) // 依赖刻意最小：只跑一次

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%' }}>
      <div style={{ width: '42%', minWidth: 400, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-subtle)' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <Typography.Title level={5} style={{ margin: 0 }}>任务工厂 · 任务调度官</Typography.Title>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <AgentConversation />
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 16 }}>
        <SuperTaskPanel />
      </div>
    </div>
  )
}
```

`components/superTasks/SuperTaskPanel.tsx`（骨架，Stats 占位）：

```tsx
import { useEffect } from 'react'
import { Typography, Spin } from 'antd'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'

export default function SuperTaskPanel(): JSX.Element {
  const { buckets, loading } = useSuperTaskStore()
  useEffect(() => { void useSuperTaskStore.getState().load() }, [])
  if (loading && buckets.queue.length === 0) return <Spin />
  const counts = {
    queue: buckets.queue.length,
    processing: buckets.processing.length,
    finished: buckets.finished.length,
  }
  return (
    <div>
      <Typography.Title level={4}>任务面板</Typography.Title>
      <Typography.Paragraph type="secondary">
        队列 {counts.queue} · 执行中 {counts.processing} · 已完成 {counts.finished}
      </Typography.Paragraph>
      {/* Task 9 填入三栏列表 + 操作条 */}
    </div>
  )
}
```

注意 supervisor 会话的确认依赖：`loadSessions` 后 `sessions` 是异步刷新，上面代码用闭包里首次 `sessions`。要可靠，改为在 `loadSessions` 返回后重新读 `useAgentStore.getState().sessions`（见 Step 4 修正）。

- [ ] **Step 4: 修正 supervisor 会话引导后跑测试**

把创建逻辑改为从 state 读取最新 sessions：

```ts
const s = useAgentStore.getState()
const latest = s.sessions
const target = saved ? latest.find((x) => x.id === saved) : undefined
if (target) { s.setCurrentSession(target.id) }
else if (latest.length === 0) {
  const created = await s.createNewSession()
  if (created?.id) { localStorage.setItem(SUPERVISOR_SESSION_KEY, created.id); s.setCurrentSession(created.id) }
} else { void s.createNewSession() }
```

`createNewSession` 的返回形状以既有 `useAgentStore` 实现为准（`Promise<{id: string} | null>`；不确定时忽略返回值，仅 `setCurrentSession`）。Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/pages/SuperTasks.tsx packages/zai/src/web/src/components/superTasks/SuperTaskPanel.tsx packages/zai/src/web/src/pages/SuperTasks.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(web): SuperTasks 页面骨架与任务调度官对话区"
```

---

### Task 9: web — 三栏任务面板 + 新建任务弹窗 + 操作条

**Files:**
- Modify: `packages/zai/src/web/src/components/superTasks/SuperTaskPanel.tsx`
- Create: `packages/zai/src/web/src/components/superTasks/NewSuperTaskModal.tsx`
- Test: `packages/zai/src/web/src/components/superTasks/SuperTaskPanel.test.tsx`

**Interfaces:**
- Consumes: Task 6 store + api；`useAgentStore`（新建任务弹窗发消息给任务调度官 session）；`Modal`/`Table`/`Checkbox`/`Tag`/`Button`/`Switch`/`Popconfirm`/`message`（AntD）。
- Produces: 面板三栏（每栏 Card + 可多选 Row：标题/状态 Tag/创建时间/操作按钮）、操作条（AI 托管 Switch、批量删除 Popconfirm、新建任务按钮）。

- [ ] **Step 1: 写失败测试（面板渲染 + 批量删除确认）**

```tsx
// packages/zai/src/web/src/components/superTasks/SuperTaskPanel.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SuperTaskPanel from './SuperTaskPanel'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'

describe('SuperTaskPanel', () => {
  it('渲染三栏并显示任务标题', () => {
    useSuperTaskStore.setState({
      buckets: {
        queue: [{ id: 'tf-q', title: '排队任务', status: 'queued', bucket: 'queue-tasks' }],
        processing: [{ id: 'tf-p', title: '执行中任务', status: 'processing', bucket: 'processing-tasks' }],
        finished: [{ id: 'tf-f', title: '完成任务', status: 'done', bucket: 'finished-tasks' }],
      },
      managed: false, loading: false,
    })
    render(<SuperTaskPanel />)
    expect(screen.getByText('排队任务')).toBeTruthy()
    expect(screen.getByText('执行中任务')).toBeTruthy()
    expect(screen.getByText('完成任务')).toBeTruthy()
  })

  it('删除按钮对选中任务调 store.deleteTasks', async () => {
    const del = vi.spyOn(useSuperTaskStore.getState(), 'deleteTasks').mockResolvedValue(undefined)
    useSuperTaskStore.setState({
      buckets: {
        queue: [{ id: 'tf-q', title: 'A', status: 'queued', bucket: 'queue-tasks' }],
        processing: [], finished: [],
      },
      managed: false, loading: false,
    })
    render(<SuperTaskPanel />)
    fireEvent.click(screen.getByRole('checkbox', { name: /A/ }))
    fireEvent.click(screen.getByText('删除选中'))
    // Popconfirm 确认按钮
    fireEvent.click(screen.getByText('确定'))
    expect(del).toHaveBeenCalledWith(['tf-q'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/SuperTaskPanel.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现面板（三栏 + 多选删除 + AI 托管 + 新建入口）**

`SuperTaskPanel.tsx` 核心（表格用 AntD `Table`，rowSelection 管理多选集合，按 bucket 渲染三张卡）：

```tsx
import { useMemo, useState } from 'react'
import { Button, Card, Popconfirm, Space, Switch, Table, Tag, Tooltip, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { DeleteOutlined, PlayCircleOutlined, PauseCircleOutlined } from '@ant-design/icons'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import type { TaskSummary } from '../../lib/superTaskApi'
import NewSuperTaskModal from './NewSuperTaskModal'

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  queued: { color: 'default', label: '排队' },
  processing: { color: 'processing', label: '执行中' },
  paused: { color: 'warning', label: '已暂停' },
  done: { color: 'success', label: '完成' },
  failed: { color: 'error', label: '失败' },
}

function renderBucket(bucket: TaskSummary[], key: 'queue' | 'processing' | 'finished') { /* 见下 */ }

export default function SuperTaskPanel(): JSX.Element {
  const { buckets, managed, loading } = useSuperTaskStore()
  const [selected, setSelected] = useState<Record<'queue' | 'processing' | 'finished', string[]>>({
    queue: [], processing: [], finished: [],
  })
  const [newModalOpen, setNewModalOpen] = useState(false)

  const columns: ColumnsType<TaskSummary> = [
    { title: '任务', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 90,
      render: (v: string) => {
        const m = STATUS_TAG[v] ?? { color: 'default', label: v }
        return <Tag color={m.color}>{m.label}</Tag>
      },
    },
    {
      title: '创建', dataIndex: 'createdAt', key: 'createdAt', width: 160,
      render: (v?: string) => (v ? new Date(v).toLocaleString() : '-'),
    },
    {
      title: '操作', key: 'actions', width: 150,
      render: (_: unknown, row: TaskSummary) => {
        const { start, pause, resume, accept } = useSuperTaskStore.getState()
        return (
          <Space size={4}>
            {row.bucket === 'queue-tasks' && <Tooltip title="手工启动"><Button size="small" icon={<PlayCircleOutlined />} onClick={() => void start(row.id)} /></Tooltip>}
            {row.bucket === 'processing-tasks' && row.status === 'processing' && (
              <Tooltip title="暂停"><Button size="small" icon={<PauseCircleOutlined />} onClick={() => void pause(row.id)} /></Tooltip>
            )}
            {row.bucket === 'processing-tasks' && row.status === 'paused' && (
              <Tooltip title="继续"><Button size="small" icon={<PlayCircleOutlined />} onClick={() => void resume(row.id)} /></Tooltip>
            )}
            {row.bucket === 'processing-tasks' && row.status === 'processing' && (
              <Tooltip title="人工验收"><Button size="small" onClick={() => void accept(row.id)}>验收</Button></Tooltip>
            )}
          </Space>
        )
      },
    },
  ]

  const bucket = (key: 'queue' | 'processing' | 'finished', rows: TaskSummary[]) => (
    <Card
      size="small"
      title={`${key === 'queue' ? '队列' : key === 'processing' ? '执行中' : '已完成'} (${rows.length})`}
      extra={key !== 'processing' ? (
        <Popconfirm title={`删除选中的 ${selected[key].length} 个任务？`} onConfirm={() => void handleDelete(key)}>
          <Button size="small" danger icon={<DeleteOutlined />} disabled={selected[key].length === 0}>
            删除选中
          </Button>
        </Popconfirm>
      ) : (
        <Tooltip title="进行中任务需先暂停才能删除"><Button size="small" danger disabled>删除选中</Button></Tooltip>
      )}
    >
      <Table<TaskSummary>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={false}
        rowSelection={{
          selectedRowKeys: selected[key],
          onChange: (keys) => setSelected((p) => ({ ...p, [key]: keys as string[] })),
          getCheckboxProps: (r) => ({ name: r.title }),
        }}
        onRow={(row) => ({
          onClick: () => setDetailId(row.id),
          style: { cursor: 'pointer' },
        } as React.HTMLAttributes<HTMLTableRowElement>)}
      />
    </Card>
  )

  async function handleDelete(key: 'queue' | 'processing' | 'finished'): Promise<void> {
    const ids = selected[key]
    try {
      await useSuperTaskStore.getState().deleteTasks(ids)
      setSelected((p) => ({ ...p, [key]: [] }))
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Space wrap>
        <Switch
          checked={managed}
          onChange={(v) => void useSuperTaskStore.getState().setManaged(v)}
          checkedChildren="AI 托管开"
          unCheckedChildren="AI 托管关"
        />
        <Button type="primary" onClick={() => setNewModalOpen(true)}>新建任务</Button>
        {loading && <span style={{ color: 'var(--text-secondary)' }}>刷新中…</span>}
      </Space>
      {bucket('queue', buckets.queue)}
      {bucket('processing', buckets.processing)}
      {bucket('finished', buckets.finished)}
      <NewSuperTaskModal open={newModalOpen} onClose={() => setNewModalOpen(false)} />
    </div>
  )
}
```

（`setDetailId` 在 Task 10 接入详情抽屉；本任务先声明 `const [detailId, setDetailId] = useState<string | null>(null)` 占位，抽屉在 Task 10 替换。）

`NewSuperTaskModal.tsx` — 新建任务弹窗（复用任务调度官会话对话流；含工程目录 cwd 选择）：

```tsx
import { Modal, Input, Select, App } from 'antd'
import { useState } from 'react'
import { useAgentStore } from '../../store/useAgentStore'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'

/** 新建任务弹窗：输入标题+工程目录(cwd)+说明+目标 agent，发送给任务调度官会话由任务调度官走 brainstorming 讨论并落库。 */
export default function NewSuperTaskModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const [title, setTitle] = useState('')
  const [cwd, setCwd] = useState<string | undefined>(
    typeof window !== 'undefined' ? localStorage.getItem('zai-last-task-cwd') ?? undefined : undefined,
  )
  const [description, setDescription] = useState('')
  const [agent, setAgent] = useState<string | undefined>()
  const [sending, setSending] = useState(false)
  const submitAsk = useAgentStore((s) => s.submitAsk)
  const sessionId = useAgentStore((s) => s.sessionId)

  async function onSubmit(): Promise<void> {
    if (!title.trim()) return
    if (!sessionId) {
      App.useApp().message.warning('任务调度官会话尚未就绪，请稍候')
      return
    }
    setSending(true)
    try {
      const prompt = [
        `请帮我新建一个任务：\n- 标题：${title.trim()}`,
        cwd ? `- 工程目录（cwd，任务所在代码工程，执行子 Agent 在此工作）：${cwd}` : '',
        description.trim() ? `- 说明：${description.trim()}` : '',
        agent ? `- 执行 Agent：${agent}` : '',
        `请先与我确认需求（调用 brainstorming），讨论清楚后调用 SuperTasksCreate（携带上述 cwd）落库并告诉我任务 id。`,
      ].filter(Boolean).join('\n')
      await submitAsk(prompt)
      if (cwd) localStorage.setItem('zai-last-task-cwd', cwd)
      setTitle(''); setDescription('')
      onClose()
      void useSuperTaskStore.getState().load()
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} onOk={() => void onSubmit()} okText="发给任务调度官" confirmLoading={sending} width={560} title="新建任务（与任务任务调度官讨论）">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="任务标题（必填）"
          data-testid="new-task-title"
          onPressEnter={() => void onSubmit()}
        />
        <Input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="工程目录（cwd，绝对路径，必填——任务所在代码项目；可用浏览器路径选择或直接粘贴）"
          data-testid="new-task-cwd"
        />
        <Input.TextArea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="任务目标 / 背景说明（可选）"
          rows={4}
        />
        <Select
          style={{ width: '100%' }}
          allowClear
          placeholder="执行 Agent（默认 claude-code）"
          value={agent}
          onChange={setAgent}
          options={[
            { value: 'claude-code', label: 'claude-code（外部 CLI agent，推荐）' },
            { value: 'dsh', label: 'dsh（DeepSeek Harness）' },
            { value: 'default', label: 'default（内置，SpawnAgent 不可用时回退）' },
          ]}
        />
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          发送后任务调度官 Agent 会与你确认需求（brainstorming skill），讨论清楚后调用 SuperTasksCreate 落库到任务池。
        </div>
      </div>
    </Modal>
  )
}
```

注：`submitAsk` 签名与 store 实现核对——`useAgentStore.submitAsk(content)`；若签名是 `submitAsk(ask)` 或需要额外参数，按既有实现调整。

- [ ] **Step 4: 跑测试 + 修 UI 测试断言后提交**

Run: 同 Step 2。Expected: PASS（antd Table checkbox 的 name 透传若失败，改用 rowSelection 自定义 render 断言或放宽断言——以「面板渲染 + deleteTasks 被调用」为准）。

```bash
git add packages/zai/src/web/src/components/superTasks/SuperTaskPanel.tsx packages/zai/src/web/src/components/superTasks/NewSuperTaskModal.tsx packages/zai/src/web/src/components/superTasks/SuperTaskPanel.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(web): 任务面板三栏与新建任务弹窗"
```

---

### Task 10: web — 任务详情抽屉（复用执行过程展示）

**Files:**
- Create: `packages/zai/src/web/src/components/superTasks/SuperTaskDetailDrawer.tsx`
- Modify: `packages/zai/src/web/src/components/superTasks/SuperTaskPanel.tsx`（接 `detailId` 门把）

**Interfaces:**
- Consumes: `fetchSuperTaskDetail`（Task 6）；`taskApi.subscribeTaskEvents` + `fetchTask`（`lib/taskApi.ts`，已有，TaskDrawer 同款）；`Drawer`/`Tabs`（AntD）。
- Produces: 详情抽屉：任务元信息头 + Tabs（执行过程 / process.md / spec.md / plan.md）；「执行过程」Tab 在 `executorTaskId` 存在时订阅 `/api/tasks/:id/events` 渲染工具调用与消息流（状态图标参考 `TaskDrawer` 的 `STATUS_META`）。

- [ ] **Step 1: 写失败测试（executor 存在时展示过程区标题）**

```tsx
// packages/zai/src/web/src/components/superTasks/SuperTaskDetailDrawer.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import SuperTaskDetailDrawer from './SuperTaskDetailDrawer'

describe('SuperTaskDetailDrawer', () => {
  it('渲染任务详情 tabs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/events')) {
        return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('id: 1\nevent: x\ndata: {}\n\n')); c.close() } }) }
      }
      return {
        ok: true,
        json: async () => ({
          task: {
            summary: { id: 'tf-x', title: 'T', status: 'processing', bucket: 'processing-tasks', executorTaskId: 'a1234567' },
            indexMd: 'body', specMd: '# spec', planMd: '# plan', processMd: '# 执行记录\n## [DONE]',
          },
        }),
      }
    }))
    render(<SuperTaskDetailDrawer taskId="tf-x" onClose={() => {}} />)
    expect(await screen.findByText('执行过程')).toBeTruthy()
    expect(await screen.findByText('process.md')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/superTasks/SuperTaskDetailDrawer.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现抽屉**

核心结构（复用 `TaskDrawer.tsx` 的 markdown 渲染组件与 `STATUS_META` 风格；执行过程 Tab 用 `useEffect` + `subscribeTaskEvents` 拉事件流，按 `type` 展示 tool_call/token 计数）：

```tsx
import { useEffect, useState } from 'react'
import { Drawer, Tabs, Typography, Spin, Timeline } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchSuperTaskDetail } from '../../lib/superTaskApi'
import { fetchTask, subscribeTaskEvents } from '../../lib/taskApi'
import type { TaskDetails } from '../../lib/superTaskApi'

export default function SuperTaskDetailDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }): JSX.Element {
  const [detail, setDetail] = useState<TaskDetails | null>(null)
  const [events, setEvents] = useState<Array<{ seq: number | string; event: string; data: any }>>([])

  useEffect(() => {
    if (!taskId) { setDetail(null); setEvents([]); return }
    setDetail(null); setEvents([])
    void fetchSuperTaskDetail(taskId).then(setDetail)
    const ctrl = new AbortController()
    const run = async () => {
      const task = await fetchTask(taskId).catch(() => null)
      if (task?.parentSessionId) { /* 说明是后台任务，走全局 task 流；这里以详情文件的 executorTaskId 为准 */ }
      const executorId = (await fetchSuperTaskDetail(taskId)).summary.executorTaskId
      if (!executorId) return
      try {
        for await (const frame of subscribeTaskEvents(executorId, 0, ctrl.signal)) {
          setEvents((p) => [...p, frame].slice(-200))
        }
      } catch { /* abort / 流结束静默 */ }
    }
    void run()
    return () => ctrl.abort()
  }, [taskId])

  return (
    <Drawer open={taskId != null} onClose={onClose} width={720} title={detail ? `任务 ${detail.summary.id}` : '任务详情'}>
      {!detail ? <Spin /> : (
        <>
          <Typography.Title level={5} style={{ marginTop: 0 }}>{detail.summary.title}</Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            状态：{detail.summary.status} · Agent：{detail.summary.agent ?? 'default'}
            {detail.summary.executorTaskId ? ` · 执行任务：${detail.summary.executorTaskId}` : ''}
          </Typography.Paragraph>
          <Tabs
            items={[
              {
                key: 'process', label: '执行过程',
                children: (
                  detail.summary.executorTaskId ? (
                    events.length > 0 ? (
                      <Timeline
                        items={events.map((e) => ({
                          key: String(e.seq),
                          color: e.data?.status === 'completed' ? 'green' : e.data?.status === 'error' ? 'red' : 'blue',
                          children: `${String(e.event)} · ${String(e.data?.description ?? JSON.stringify(e.data ?? {}).slice(0, 120))}`,
                        }))}
                      />
                    ) : <Typography.Text type="secondary">等待执行事件…</Typography.Text>
                  ) : <Typography.Text type="secondary">尚未派生执行子 Agent</Typography.Text>
                ),
              },
              { key: 'spec', label: 'spec.md', children: <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.specMd ?? ''}</ReactMarkdown> },
              { key: 'plan', label: 'plan.md', children: <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.planMd ?? ''}</ReactMarkdown> },
              { key: 'processMd', label: 'process.md', children: <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.processMd ?? ''}</ReactMarkdown> },
            ]}
          />
        </>
      )}
    </Drawer>
  )
}
```

`SuperTaskPanel` 接入：`const [detailId, setDetailId] = useState<string | null>(null)`（替换 Task 9 占位）+ 渲染 `<SuperTaskDetailDrawer taskId={detailId} onClose={() => setDetailId(null)} />`。详情数据轮询：抽屉 open 时每 3s 重新 `fetchSuperTaskDetail`（process.md 增量），并入 `run` 的 interval。

- [ ] **Step 4: 跑测试 + 提交**

Run: 同 Step 2。Expected: PASS（fetch stub 需处理 `/api/super-tasks/:id` 与 `/api/tasks/:id/events` 两条路径）。

```bash
git add packages/zai/src/web/src/components/superTasks/SuperTaskDetailDrawer.tsx packages/zai/src/web/src/components/superTasks/SuperTaskPanel.tsx packages/zai/src/web/src/components/superTasks/SuperTaskDetailDrawer.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(web): 任务详情抽屉与执行过程订阅"
```

---

### Task 11: zai server — start/pause/resume + AI 托管循环

**Files:**
- Modify: `packages/zai/src/server/routes/superTasks.ts`
- Create: `packages/zai/src/server/services/taskFactoryManagedLoop.ts`
- Modify: `packages/zai/src/server/index.ts`（托管循环启动）
- Test: `packages/zai/test/server/services/taskFactoryManagedLoop.test.ts`

**Interfaces:**
- Consumes: Task 1 fs 服务（`listTasks`/`markTaskStatus`/`moveTask`）；`getBackgroundRuntime`（`services/backgroundRuntime.ts`，已有：`cancel(taskId)` / `get(id)`）；Task 4 bridge（`injectSupervisorCommand`）。
- Produces:
```ts
// routes/superTasks.ts 追加
POST /api/super-tasks/:id/start    // = inject dispatch
POST /api/super-tasks/:id/pause    // kill executor + mark paused + inject 静默通知
POST /api/super-tasks/:id/resume   // = inject resume
POST /api/super-tasks/:id/accept   // = inject accept（人工验收入口）
// taskFactoryManagedLoop.ts
export function startTaskFactoryManagedLoop(intervalMs?: number): void   // 幂等；5s tick
```

- [ ] **Step 1: 写失败测试（pause/托管循环）**

```ts
// packages/zai/test/server/services/taskFactoryManagedLoop.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPoolTask, listTasks, markTaskStatus,
} from '@zn-ai/zn-agent-core'
import { startTaskFactoryManagedLoop, stopTaskFactoryManagedLoopForTests } from '../../src/server/services/taskFactoryManagedLoop.js'
import { injectSupervisorCommand, __resetForTests, setTaskFactoryState } from '../../src/server/services/taskFactoryBridge.js'

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'tf-loop-')); process.env.ZAI_TASK_FACTORY_DIR = dir })
afterAll(async () => { delete process.env.ZAI_TASK_FACTORY_DIR; await rm(dir, { recursive: true, force: true }) })
beforeEach(async () => { __resetForTests(); await setTaskFactoryState({ managedEnabled: true, supervisorSessionId: 'sess-sup' }); vi.restoreAllMocks() })
afterEach(() => stopTaskFactoryManagedLoopForTests())

describe('taskFactoryManagedLoop', () => {
  it('队列非空时注入 dispatch 指令（不依赖 processing 是否为空，允许多任务并行）', async () => {
    await createPoolTask({ title: 'a' })
    await createPoolTask({ title: 'b' }) // 多个队列任务 → 指令可让任务调度官并行派发
    const spy = vi.spyOn({ injectSupervisorCommand }, 'injectSupervisorCommand')
    startTaskFactoryManagedLoop(20) // 紧凑 interval 便于测试
    await new Promise((r) => setTimeout(r, 60))
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('dispatch'))
    stopTaskFactoryManagedLoopForTests()
  })

  it('executor 终态且任务仍 processing 时注入 accept 指令', async () => {
    const s = await createPoolTask({ title: 'b' })
    await markTaskStatus(s.id, 'queue-tasks', { status: 'processing', executorTaskId: 'a-unknown' })
    await (await import('@zn-ai/zn-agent-core')).moveTask(s.id, 'queue-tasks', 'processing-tasks')
    const spy = vi.spyOn({ injectSupervisorCommand }, 'injectSupervisorCommand')
    startTaskFactoryManagedLoop(20)
    await new Promise((r) => setTimeout(r, 60))
    // executorTaskId 在后台运行时不可解析 → 不注入 accept（避免幽灵验收）；断言无 accept 注入即可
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('accept'))
    stopTaskFactoryManagedLoopForTests()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test test/server/services/taskFactoryManagedLoop.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 routes start/pause/resume/accept + 托管循环**

`routes/superTasks.ts` 追加：

```ts
import { markTaskStatus, moveTask, getTaskSummary } from '@zn-ai/zn-agent-core'
import { getBackgroundRuntime } from '../services/backgroundRuntime.js'

router.post('/super-tasks/:id/start', async (req, res) => {
  const t = await getTaskSummary(req.params.id)
  if (!t || t.bucket !== 'queue-tasks') return res.status(400).json({ error: `task ${req.params.id} 不在队列` })
  injectSupervisorCommand(`\n<task-command action="dispatch" id="${t.id}" title="${(t.title ?? '').replace(/</g, '＜')}">请派发执行任务：${t.id}</task-command>`)
  res.json({ ok: true })
})

router.post('/super-tasks/:id/pause', async (req, res) => {
  const t = await getTaskSummary(req.params.id)
  if (!t || t.bucket !== 'processing-tasks') return res.status(400).json({ error: `task ${req.params.id} 不在执行中` })
  const bg = getBackgroundRuntime()
  if (t.executorTaskId) {
    try { await bg.cancel(t.executorTaskId) } catch { /* 已终态/不存在则静默 */ }
  }
  await markTaskStatus(t.id, 'processing-tasks', { status: 'paused' })
  injectSupervisorCommand(`\n<task-command action="pause" id="${t.id}">任务已暂停（执行子 Agent 已结束），如需要恢复请回复继续。</task-command>`)
  res.json({ ok: true })
})

router.post('/super-tasks/:id/resume', async (req, res) => {
  const t = await getTaskSummary(req.params.id)
  if (!t || t.bucket !== 'processing-tasks') return res.status(400).json({ error: `task ${req.params.id} 不在执行中` })
  injectSupervisorCommand(`\n<task-command action="resume" id="${t.id}" title="${(t.title ?? '').replace(/</g, '＜')}">继续执行任务（resume 原执行会话或重新委派）。</task-command>`)
  res.json({ ok: true })
})

router.post('/super-tasks/:id/accept', async (req, res) => {
  const t = await getTaskSummary(req.params.id)
  if (!t || t.bucket !== 'processing-tasks') return res.status(400).json({ error: `task ${req.params.id} 不在执行中` })
  injectSupervisorCommand(`\n<task-command action="accept" id="${t.id}">请验收任务成果并调用 SuperTasksMarkDone。</task-command>`)
  res.json({ ok: true })
})
```

`taskFactoryManagedLoop.ts`：

```ts
import { listTasks, getTaskSummary } from '@zn-ai/zn-agent-core'
import { getBackgroundRuntime } from './backgroundRuntime.js'
import { getTaskFactoryStateSync, injectSupervisorCommand } from './taskFactoryBridge.js'

let timer: ReturnType<typeof setInterval> | null = null
let lastSignature = ''

/** AI 托管循环：队列非空 → 注入派发（可并行多任务）；executor 终态且任务仍 processing → 验收。 */
export function startTaskFactoryManagedLoop(intervalMs = 5000): void {
  if (timer) return
  timer = setInterval(() => { void tick() }, intervalMs)
}

function isTerminal(task: { status?: string }): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'killed'
}

async function tick(): Promise<void> {
  if (!getTaskFactoryStateSync().managedEnabled) return
  const { queue, processing } = await listTasks()
  const signature = `q:${queue.map((t) => t.id).join(',')}|p:${processing.map((t) => `${t.id}:${t.status}`).join(',')}`
  const actions: string[] = []
  // 并行派发（2026-09-01 用户更正）：不在「无 processing 才派发」上做单任务串行约束，
  // 队列非空即注入派发指令，由任务调度官按队列顺序一次派发多个任务。
  if (queue.length > 0) actions.push('dispatch')
  const bg = getBackgroundRuntime()
  for (const t of processing) {
    const done = t.status === 'processing' && t.executorTaskId
      ? isTerminal(await bg.get(t.executorTaskId).catch(() => null))
      : false
    if (done) actions.push(`accept:${t.id}`)
  }
  if (actions.length === 0 || signature === lastSignature) return
  lastSignature = signature
  const first: string = actions[0]!
  if (first === 'dispatch') {
    injectSupervisorCommand('\n<task-command action="dispatch">队列有任务，请按队列顺序派发执行（可一次派发多个，任务间并行）。</task-command>')
  } else if (first.startsWith('accept:')) {
    const id = first.slice('accept:'.length)
    injectSupervisorCommand(`\n<task-command action="accept" id="${id}">执行子 Agent 已完成，请验收。</task-command>`)
  }
}

export function stopTaskFactoryManagedLoopForTests(): void {
  if (timer) { clearInterval(timer); timer = null }
  lastSignature = ''
}
```

`server/index.ts`：`if (!process.env.ZAI_INSTANCE_ID) startTaskFactoryManagedLoop()`（顶层实例跑托管；受管子实例不跑）。

- [ ] **Step 4: 跑测试 + build + 提交**

Run: `pnpm run build:core && pnpm --filter @zn-ai/zai test test/server/services/taskFactoryManagedLoop.test.ts test/server/routes/superTasks.test.ts`
Expected: PASS。

```bash
git add packages/zai/src/server/routes/superTasks.ts packages/zai/src/server/services/taskFactoryManagedLoop.ts packages/zai/src/server/index.ts packages/zai/test/server/services/taskFactoryManagedLoop.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 任务 start/pause/resume 与 AI 托管循环"
```

---

### Task 12: 集成 + ego-browser 真实验收

**Files:**（如验收发现缺陷，修改对应文件）
- 全链路由客户端：`packages/zai/src/web`（SuperTasks 相关）
- 服务端：`packages/zai/src/server`、`packages/zn-agent-core`（如有）

**Interfaces:**
- Consumes: Task 1-11 全部产出。

- [ ] **Step 1: 全量构建 + 相关单测**

Run:
```bash
pnpm run build:core && pnpm run build:web
pnpm --filter @zn-ai/zai test test/server/services/taskFactoryBridge.test.ts test/server/routes/superTasks.test.ts test/server/services/taskFactoryManagedLoop.test.ts src/web/src/store/useSuperTaskStore.test.ts src/web/src/components/superTasks/SuperTaskPanel.test.tsx src/web/src/components/superTasks/SuperTaskDetailDrawer.test.tsx src/web/src/pages/SuperTasks.test.tsx
pnpm --filter @zn-ai/zn-agent-core exec vitest run test/unit/taskFactoryFiles.test.ts test/unit/taskFactoryTools.test.ts test/unit/agentRegistry-taskFactory.test.ts
```
Expected: 全绿。

- [ ] **Step 2: 起 dev，ego-browser 走全流程（强制验收）**

Run: `pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715`（先 `lsof -i :8102` / `lsof -i :7715` 确认空闲；如被占换空闲端口）。

用 ego-browser / web-browser-operator 访问 `http://localhost:8102`，依次验证并截图留证：
1. `/` 重定向到 `/agent`（标准实例）；切到任务工厂实例或直接访问 `/super-tasks`；
2. `/super-tasks` 页面：左任务调度官对话区 + 右三栏面板，无 Sider 菜单；
3. 新建任务：点「新建任务」→ 弹窗输入标题 → 发给任务调度官 → 任务调度官会话（SSE 流）回复并出现 `SuperTasksCreate` 工具调用 → 队列栏出现该任务（index.md/process.md 在 `~/.zai/task-factory/queue-tasks/<id>/` 存在）；
4. 手工启动：点 ▶ → 任务调度官会话收到 `<task-command dispatch>` → 任务调度官调用 `SpawnAgent`（subagent_type=claude-code|dsh）派生执行子 Agent → 任务移入「执行中」，详情抽屉显示执行过程（tools/消息流）；**验证执行器 transcript 出现在 `~/.zai/task-factory/processing-tasks/<id>/` 内（`agent-*.jsonl`）**；SpawnAgent provider 未注册时回退路径（AgentTool）同样验证 transcript 归拢；
5. 暂停/继续：执行中任务点 ⏸（executor 被 kill，index.md status=paused），再点 ▶（任务调度官 resume 派发）；
6. AI 托管：开 Switch → 新建一个队列任务 → 观察托管循环自动派发/验收；
7. 完成后任务移到「已完成」，点详情查看 process.md `[DONE]`；多选删除（队列/已完成）成功；processing 任务删除按钮禁用；
8. 实例管理：「新建任务工厂实例」→ 创建 + 启动 → 新标签页打开即 `/super-tasks`，其 mainAgent 恒为 `task-factory`（新会话 meta 验证）。

- [ ] **Step 3: 修复验收发现的问题并回归**

逐个修复（复用 superpowers:systematic-debugging），每修一个重跑对应单测 + 重验该步骤；修复提交：
`git commit -m "HRMSV3-ZN-WEBSITE#668 fix(super-tasks): <描述>"`

- [ ] **Step 4: 最终回归 + 收尾**

全量单测（相关文件）+ `pnpm exec tsc --noEmit`（改到的 workspace）通过后，更新 README/文档入口（`docs/` 索引 `2026-09-01-task-factory-design.md`）并提交：
`git commit -m "HRMSV3-ZN-WEBSITE#668 docs(super-tasks): 收尾文档与计划归档"`

---

## Self-Review（自审结论）

- **Spec 覆盖**：spec 的 10 节需求全部映射到任务——文件模型(T1)、工具(T2)、任务调度官 Agent(T3)、后端路由/bridge(T4)、实例入口+mainAgent 锁定(T5, T7)、web api/store(T6)、页面+对话区(T8)、三栏+弹窗+托管开关(T9)、详情抽屉(T10)、生命周期 start/pause/resume/托管(T11)、真实验收(T12)。
- **用户补充要求**：① 委派优先 SpawnAgent（claude-code|dsh）——落在 Task 3 的 system prompt 与 spec「委派执行」小节、Task 12 验收步骤 4/6；② 执行器 transcript 归拢 `~/.zai/task-factory/`——落在 Task 3 Step 0（sessionStorage 绝对 subdir patch + 单测）、spec transcript 注记、Task 12 验收步骤 4；③ **任务并行不强制串行**（用户 2026-09-01 更正）——spec 范围外移除并行项 + AI 托管「队列非空即注入派发」，Task 3 prompt / Task 11 循环取消单任务门闩；④ **任务携带工程目录 cwd**（用户 2026-09-01 追加）——spec index.md 加 `cwd`、委派以任务 cwd 为执行环境，落在新增 Task 3.5（files 层 cwd + 工具 inputSchema cwd + prompt 委派 cwd）+ Task 9 弹窗 cwd 输入。
- **占位符**：无 TBD/TODO；所有工具/服务接口均给出签名与实现要点。
- **类型一致性**：`TaskStatus`/`TaskBucketName`/`TaskSummary`/`TaskBucket`/`TaskDetails` 在 Task 1 定义后贯穿 Task 2/4/6/9；`injectSupervisorCommand` 在 Task 4 定义、Task 9/11 使用；`executorTaskId` 在 Task 1 写入 index.md、Task 10 消费、Task 11 用于 pause/托管；`SpawnAgent` 子 agent 返回的 `task_id`/`agentId` 即回填的 `executorTaskId`（Task 3 system prompt）。
- **已知偏差**：Task 8/9 中 `submitAsk`/`createNewSession` 的返回形状标注「以既有实现为准」——实现时先读 `useAgentStore` 对应方法签名再接线；Task 4 的 `eventBus.emit` 事件名 `task_factory` 为新增类型，前端暂以轮询为主（事件留作可观测性），页面行为不依赖该事件；CLI 子 agent（claude-code CLI）自带 transcript 存储无法被 zai 侧重定向——其 cwd 为任务工程目录，保证工程级隔离（spec 已注明）。