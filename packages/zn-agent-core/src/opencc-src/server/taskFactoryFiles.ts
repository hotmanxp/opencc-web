import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomInt } from 'node:crypto'
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
  completedAt?: string | null
  /** 执行器 background task id(SpawnAgent 返回值,Move 时回填)。 */
  executorTaskId?: string | null
  /** 验证器 background task id(verifier SpawnAgent 返回值,Move 就地回填)。 */
  verifierTaskId?: string | null
  /**
   * 调度优先级(2026-09-02 任务工厂升级)。P0 最紧急、P3 最不紧急;缺省 P2。
   * SuperTasksList 输出按 priority ASC(数值小 → 优先)→ createdAt ASC 排,
   * 主管 dispatch 时挑 priority 最高(数值最小)且依赖完成的任务并行派发。
   */
  priority?: TaskPriority
  /** 依赖的任务 id 列表;所有依赖任务 status=done 时本任务才可派发。 */
  dependsOn?: string[]
  /**
   * 任务创建模式(zai patch 2026-09-04, quick-intake):
   *  - 'quick': 跳过 brainstorming + 不生成 plan.md / brainstorm.md + 轻量验证。
   *  - 'full' : 完整 intake 流程(默认)。
   * 历史任务与 full 模式读不到该字段,缺省回落 full(向后兼容)。
   */
  mode?: TaskMode
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
export interface TaskDetails { summary: TaskSummary; specMd: string; planMd: string; processMd: string; verificationMd: string; brainstormMd: string }

/**
 * intake 文档强校验契约(2026-09-03)。createPoolTask 写入的 spec/plan 骨架
 * 占位文本 —— checkTaskIntakeDocs 用「去掉标题/占位行后是否仍有实质内容」
 * 判定文档缺失,骨架原样视为未填。提示词侧(task-intake agent)声明同一契约:
 * 用户关闭新建任务弹窗时前端会调 checkTaskIntakeDocs,缺失文档回流对话要求补齐。
 */
export const INTAKE_REQUIRED_DOCS = ['docs/spec.md', 'docs/plan.md', 'docs/brainstorm.md'] as const
export type IntakeDocPath = (typeof INTAKE_REQUIRED_DOCS)[number]
/** createPoolTask 缺省写入的骨架文本(抽常量供写入与校验共用)。 */
export const DEFAULT_SPEC_SKELETON = '# 需求规格\n\n（需求讨论后由主管补充）\n'
export const DEFAULT_PLAN_SKELETON = '# 执行计划\n\n（执行前由主管补充）\n'
/** 骨架占位行标记:整行含以下文案视为未填。 */
const INTAKE_PLACEHOLDER_MARKERS = ['（需求讨论后由主管补充）', '（执行前由主管补充）']

/** 判定文档是否有实质内容:去掉 markdown 标题、空行、占位行后,非空白字符 ≥ 20。 */
function intakeDocHasSubstance(text: string): boolean {
  const kept = text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      if (t === '') return false
      if (t.startsWith('#')) return false
      if (INTAKE_PLACEHOLDER_MARKERS.some((m) => t.includes(m))) return false
      return true
    })
    .join('')
  return kept.replace(/\s/g, '').length >= 20
}

export interface IntakeDocCheck {
  ok: boolean
  missing: IntakeDocPath[]
  /**
   * 任务创建模式(zai patch 2026-09-04, quick-intake)。
   *  - 'full' :沿用三份文档校验(spec.md / plan.md / brainstorm.md)。
   *  - 'quick':只校验 spec.md 实质内容;plan.md / brainstorm.md 不会被创建。
   * 缺省回落 full(向后兼容历史任务)。
   */
  mode: TaskMode
}

/** quick 模式只校验 docs/spec.md(plan.md / brainstorm.md 根本不会被创建)。 */
const QUICK_INTAKE_DOCS = ['docs/spec.md'] as const

/**
 * 校验任务目录下 intake 必需文档是否已填写实质内容。缺失判定:文件不存在、
 * 为空、或仍是 createPoolTask 写入的骨架占位。
 *  - full 模式:校验 docs/spec.md / docs/plan.md / docs/brainstorm.md。
 *  - quick 模式(zai patch 2026-09-04):只校验 docs/spec.md(plan.md /
 *    brainstorm.md 不在 missing 清单,因为它们本来就不会被创建)。
 * 任务不存在返回 null。
 */
export async function checkTaskIntakeDocs(id: string, bucket?: TaskBucketName): Promise<IntakeDocCheck | null> {
  const summary = await getTaskSummary(id, bucket)
  if (!summary) return null
  const dir = taskDir(summary.bucket, id)
  const mode: TaskMode = summary.mode ?? DEFAULT_TASK_MODE
  const docs = mode === 'quick' ? QUICK_INTAKE_DOCS : INTAKE_REQUIRED_DOCS
  const missing: IntakeDocPath[] = []
  for (const doc of docs) {
    const f = join(dir, doc)
    if (!existsSync(f)) {
      missing.push(doc)
      continue
    }
    const text = await readFile(f, 'utf-8').catch(() => '')
    if (!intakeDocHasSubstance(text)) missing.push(doc)
  }
  return { ok: missing.length === 0, missing, mode }
}

const BUCKETS: TaskBucketName[] = ['queue-tasks', 'processing-tasks', 'verifying-tasks', 'finished-tasks']
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 新格式任务元数据文件名(2026-09-02 起替代 index.md)。 */
export const TASK_YAML_FILENAME = 'task.yaml'
/** 历史文件名,只读兼容;不再由本模块写入。 */
export const LEGACY_INDEX_MD_FILENAME = 'index.md'

/** task.yaml 顶层字段集合(写入/校验都用它做白名单,避免无关字段被序列化进去)。 */
const TASK_YAML_FIELDS = [
  'id', 'title', 'status', 'agent', 'verifierAgent', 'cwd',
  'description', 'createdAt', 'startedAt', 'completedAt', 'executorTaskId', 'verifierTaskId',
  // zai patch (2026-09-02, priority + dependsOn 调度):
  // priority 缺省 P2,dependsOn 缺省 [];写入校验都用白名单,避免无关字段。
  'priority', 'dependsOn',
  // zai patch (2026-09-04, 任务工厂 quick-intake):
  // mode: 'quick' = 快速创建任务(只 task.yaml + process.md + 最小 docs/spec.md);
  //       'full'   = 完整 intake 流程(三份文档齐全 + brainstorming)。
  // full 模式省略(序列化时不写入);仅 quick 显式落盘,读路径容错 undefined→full。
  'mode',
] as const

/** 任务在 yaml 里允许的 status 字符串。 */
type TaskYamlScalar =
  | string
  | number
  | boolean
  | null
  | undefined
  | TaskYamlScalar[]

/**
 * 调度优先级(2026-09-02 任务工厂升级):数值越小越优先派发。
 * 缺省 P2(普通);P0/P1 紧急,P3 低。
 */
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3'
export const TASK_PRIORITIES: readonly TaskPriority[] = ['P0', 'P1', 'P2', 'P3'] as const
export const DEFAULT_TASK_PRIORITY: TaskPriority = 'P2'
/** 排序键映射:P0→0, P1→1, P2→2, P3→3;数值小 → 优先派发。 */
export const PR_ORDER: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }
/** 把任意值规整成合法 priority;非法值回落到缺省 P2(创建阶段 fail loud;读取/列表兜底)。 */
export function normalizePriority(v: unknown): TaskPriority {
  return v === 'P0' || v === 'P1' || v === 'P2' || v === 'P3' ? v : DEFAULT_TASK_PRIORITY
}

/**
 * 任务创建模式(zai patch 2026-09-04, quick-intake):
 *  - 'quick': 快速创建,跳过 brainstorming;任务目录只生成 task.yaml + process.md + 最小
 *    docs/spec.md(仅 title/description/priority/cwd 快照);intake gate 与 verifier 都按
 *    mode 分流,只校验 / 只审查 spec.md。
 *  - 'full' : 完整 intake 流程(头脑风暴 + 三份文档 + 完整 spec 对齐验收)。
 *  兼容历史 full 任务 —— mode 字段缺省视为 full。
 */
export type TaskMode = 'quick' | 'full'
export const TASK_MODES: readonly TaskMode[] = ['quick', 'full'] as const
export const DEFAULT_TASK_MODE: TaskMode = 'full'
/** 把任意值规整成合法 mode;非法值回落到缺省 full(读取容错)。 */
export function normalizeMode(v: unknown): TaskMode {
  return v === 'quick' || v === 'full' ? v : DEFAULT_TASK_MODE
}

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

/** 解析 task.yaml 文本为 TaskYaml。空文件/缺失字段都安全(默认 undefined)。
 *  dependsOn 是 string[];YAML 解析后是数组,逐项校验类型并过滤非字符串。
 */
function parseTaskYaml(text: string): TaskYaml {
  const parsed = (YAML.parse(text) ?? {}) as Record<string, unknown>
  const out = {} as TaskYaml
  for (const k of TASK_YAML_FIELDS) {
    const v = parsed[k]
    if (v === null) out[k] = null
    else if (v === undefined) continue
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v
    } else if (k === 'dependsOn' && Array.isArray(v)) {
      // 只保留字符串元素;过滤掉 null/undefined/对象等异常值,容错坏数据。
      const arr = v.filter((x): x is string => typeof x === 'string' && x.length > 0)
      out[k] = arr
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
  /**
   * 调度优先级(2026-09-02)。缺省 P2;非法值 fail loud(intake 阶段已校验)。
   * 主管 dispatch 按 priority ASC(P0 最先)→ createdAt ASC 派发。
   */
  priority?: TaskPriority
  /**
   * 依赖的任务 id 列表(2026-09-02)。所有依赖任务 status=done 时本任务才可派发;
   * 缺省 []。
   */
  dependsOn?: string[]
  /**
   * 任务创建模式(2026-09-04, quick-intake)。缺省 'full':
   *  - 'full' :生成 task.yaml + process.md + docs/spec.md(完整) +
   *             docs/plan.md(空骨架) + docs/brainstorm.md(空骨架)。
   *  - 'quick':生成 task.yaml(写入 mode: quick)+ process.md + 最小 docs/spec.md
   *             (title/description/priority/cwd 快照);不生成 plan.md / brainstorm.md。
   * intake gate 与 verifier 按 mode 分流,只校验 / 只审查 spec.md。
   */
  mode?: TaskMode
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
  const priority: TaskPriority = input.priority ?? DEFAULT_TASK_PRIORITY
  // 显式校验 priority;intake 应已把控,这里 fail loud 兜底(避免 P0/P1/P2/P3
  // 之外的值穿透进 task.yaml,污染下游调度排序)。
  if (!TASK_PRIORITIES.includes(priority)) {
    throw new Error(`invalid priority ${JSON.stringify(input.priority)} (allowed: ${TASK_PRIORITIES.join(', ')})`)
  }
  const dependsOn = input.dependsOn ?? []
  // 依赖必须是非空字符串数组,且不允许自依赖;每个 id 必须满足基础格式(tf-xxxx)。
  for (const d of dependsOn) {
    if (typeof d !== 'string' || d.length < 4) {
      throw new Error(`invalid dependsOn entry ${JSON.stringify(d)} (expected non-empty task id string)`)
    }
    if (d === id) {
      throw new Error(`task ${id} cannot depend on itself (dependsOn contains its own id)`)
    }
  }
  // zai patch (2026-09-04, quick-intake):mode 分流。缺省 full(向后兼容);
  // 非法值 fail loud,避免脏数据穿透。full 模式 mode 字段在 yaml 里**不写入**
  // (避免污染所有历史任务),只 quick 显式落盘。
  const mode: TaskMode = input.mode ?? DEFAULT_TASK_MODE
  if (!TASK_MODES.includes(mode)) {
    throw new Error(`invalid mode ${JSON.stringify(input.mode)} (allowed: ${TASK_MODES.join(', ')})`)
  }
  // 仅 quick 模式写入 mode 字段 —— 避免 yaml 里出现 `mode: null` 污染历史 full 任务。
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
    verifierTaskId: null,
    priority,
    dependsOn,
    ...(mode === 'quick' ? { mode: 'quick' as const } : {}),
  }
  await writeFile(join(dir, TASK_YAML_FILENAME), serializeTaskYaml(meta), 'utf-8')
  if (mode === 'quick') {
    // quick 模式:只生成最小 spec.md(title/description/priority/cwd 快照),
    // 不生成 plan.md / brainstorm.md(intent:跳过 brainstorming,验收走轻量路径)。
    const specLines = [
      '# 需求规格(快速创建)',
      '',
      `- title: ${input.title}`,
      ...(input.description ? [`- description: ${input.description.replace(/\n/g, ' ')}`] : []),
      `- priority: ${priority}`,
      `- cwd: ${taskCwd}`,
      '',
      '> 本任务为快速创建(quick mode),无 plan.md / brainstorm.md。',
      '> 执行子 agent 直接读 task.yaml.description 作为需求上下文;',
      '> 验证走轻量路径(只跑 build + lint + 关键文件 diff 的 code review)。',
      '',
    ]
    await writeFile(join(dir, 'docs', 'spec.md'), specLines.join('\n'), 'utf-8')
  } else {
    // full 模式(默认,行为不变):生成完整三份文档骨架。
    await writeFile(join(dir, 'docs', 'spec.md'), input.spec ?? DEFAULT_SPEC_SKELETON, 'utf-8')
    await writeFile(join(dir, 'docs', 'plan.md'), input.plan ?? DEFAULT_PLAN_SKELETON, 'utf-8')
  }
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
    priority,
    dependsOn,
    mode,
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
  // 标量字段(2026-09-02 + dependsOn 后 TaskYamlScalar 变宽泛):用 String() 兜底
  // 把 number/boolean/null 统一规整成 string/null/undefined,避免 TaskSummary 字段类型不匹配。
  const str = (v: TaskYamlScalar): string | null | undefined =>
    v == null ? v : String(v)
  return {
    id, bucket,
    title: str(meta.title) ?? id,
    status: str(meta.status) ?? 'queued',
    cwd: str(meta.cwd) ?? process.cwd(),
    description: meta.description == null ? undefined : str(meta.description),
    agent: meta.agent == null ? undefined : str(meta.agent),
    verifierAgent: meta.verifierAgent == null ? null : str(meta.verifierAgent),
    createdAt: meta.createdAt == null ? undefined : str(meta.createdAt),
    startedAt: meta.startedAt == null ? undefined : str(meta.startedAt),
    completedAt: meta.completedAt == null ? undefined : str(meta.completedAt),
    executorTaskId: meta.executorTaskId == null ? null : str(meta.executorTaskId),
    verifierTaskId: meta.verifierTaskId == null ? null : str(meta.verifierTaskId),
    // priority 缺省 P2;非法值回落到 P2(读取容错,创建阶段已校验)。
    priority: normalizePriority(meta.priority),
    // dependsOn 在 task.yaml 是 string[];读取路径已过滤非字符串元素。
    dependsOn: Array.isArray(meta.dependsOn)
      ? (meta.dependsOn as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    // zai patch (2026-09-04, quick-intake):mode 缺省回落 full(向后兼容)。
    mode: normalizeMode(meta.mode),
  }
}

/**
 * 排序:priority ASC(数值小 → 优先,即 P0 → P1 → P2 → P3),
 * 同优先级按 createdAt ASC(早创建的先派发,FIFO 兜底)。
 * 暴露为命名导出,主管 prompt 与外部排序逻辑直接引用,
 * 避免在多处重写排序规则造成不一致。
 */
export function sortTasksByPriority<T extends { priority?: TaskPriority; createdAt?: string }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    const ap = PR_ORDER[normalizePriority(a.priority)]
    const bp = PR_ORDER[normalizePriority(b.priority)]
    if (ap !== bp) return ap - bp
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  })
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
  // zai patch (2026-09-02, 任务工厂升级):queue/processing/verifying/finished
  // 四个桶统一按 priority ASC + createdAt ASC 排,主管 UI/调度看到的顺序一致。
  return sortTasksByPriority(out)
}

export async function listTasks(): Promise<TaskBucket> {
  const [queue, processing, verifying, finished] = await Promise.all(BUCKETS.map(listIn))
  return { queue, processing, verifying, finished }
}

// ---------------------------------------------------------------------------
// 快照缓存 (2026-09-03, 列表接口性能优化):看板 3s 轮询绝大多数周期数据无变化,
// 用「指纹」短路掉 yaml 解析 + toSummary + 排序的读盘组装成本。指纹只 stat 不读
// 内容;缓存单槽、进程内,不做跨进程共享(已知取舍)。
// ---------------------------------------------------------------------------

/** 参与指纹的任务目录内文档文件(任务 meta 文件 task.yaml/index.md 另行处理)。 */
const FINGERPRINT_DOC_FILES = ['docs/spec.md', 'docs/plan.md', 'process.md', 'docs/verification.md'] as const

export interface TasksSnapshot {
  fingerprint: string
  buckets: TaskBucket
}

/**
 * 计算四桶目录的内容指纹(sha1)。
 * 条目 = 每个任务目录的 `<bucket>/<id>`(id 列表变化即指纹变化)+ 该目录下
 * `task.yaml`(缺失回退 legacy `index.md`,与 readTaskMeta 判定一致)及
 * {@link FINGERPRINT_DOC_FILES} 的 `<相对路径>|<mtimeMs>|<size>` 元组;
 * 文件不存在则不参与。全部字典序排序 join 后 sha1。
 * 目录不存在/为空 → 空集合,指纹稳定。只 stat 不读内容。
 * 导出供单测直接验证指纹语义(快照缓存本身是内部实现细节)。
 */
export async function computeFingerprint(): Promise<string> {
  const root = taskFactoryRoot()
  const entries: string[] = []
  for (const bucket of BUCKETS) {
    let ids: string[]
    try {
      ids = (await readdir(join(root, bucket))).filter((n) => !n.startsWith('.'))
    } catch {
      ids = [] // bucket 目录不存在 → 视作空集合
    }
    for (const id of ids) {
      const prefix = `${bucket}/${id}`
      entries.push(prefix)
      const statTuple = async (rel: string): Promise<boolean> => {
        try {
          const s = await stat(join(root, prefix, rel))
          entries.push(`${prefix}/${rel}|${s.mtimeMs}|${s.size}`)
          return true
        } catch {
          return false
        }
      }
      // meta 文件:优先 task.yaml,不存在则 legacy index.md
      if (!(await statTuple(TASK_YAML_FILENAME))) {
        await statTuple(LEGACY_INDEX_MD_FILENAME)
      }
      for (const f of FINGERPRINT_DOC_FILES) {
        await statTuple(f)
      }
    }
  }
  entries.sort()
  return createHash('sha1').update(entries.join('\n')).digest('hex')
}

/** 单槽进程内缓存;只服务快照读路径,写路径不显式失效(靠指纹自然收敛)。 */
let tasksSnapshotCache: TasksSnapshot | null = null

/**
 * 带缓存的列表快照:指纹与上次一致 → 直接复用缓存的 buckets 对象引用
 * (跳过 readdir 之外的全部解析/排序);不一致 → 全量 listTasks 并回填缓存。
 * 指纹先于 buckets 计算:listTasks 的读路径会迁移 legacy index.md(fs 副作用),
 * 迁移后下一轮指纹必然不同 → 重算一次后重新稳定,可接受。
 * 已知取舍:mtimeMs+size 在同毫秒同字节的改写会漏检,概率可忽略。
 */
export async function getTasksSnapshot(): Promise<TasksSnapshot> {
  const fingerprint = await computeFingerprint()
  if (tasksSnapshotCache && tasksSnapshotCache.fingerprint === fingerprint) {
    return tasksSnapshotCache
  }
  const buckets = await listTasks()
  tasksSnapshotCache = { fingerprint, buckets }
  return tasksSnapshotCache
}

/** 手动失效快照缓存(预留钩子:写路径/测试可强制下一轮全量重算)。 */
export function invalidateTasksSnapshot(): void {
  tasksSnapshotCache = null
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
  patch: { status?: TaskStatus; startedAt?: string | null; completedAt?: string | null; executorTaskId?: string | null; verifierTaskId?: string | null },
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
  const [specMd, planMd, processMd, verificationMd, brainstormMd] = await Promise.all([
    read('docs/spec.md', ''), read('docs/plan.md', ''), read('process.md', ''),
    read('docs/verification.md', ''), read('docs/brainstorm.md', ''),
  ])
  return { summary, specMd, planMd, processMd, verificationMd, brainstormMd }
}

export {
  serializeTaskYaml, parseTaskYaml, parseLegacyIndexMd, TASK_YAML_FIELDS,
  // sortTasksByPriority / normalizePriority / TASK_PRIORITIES / DEFAULT_TASK_PRIORITY /
  // PR_ORDER 已在文件顶部 export 声明,这里不再列(避免 TS2484 重复导出)。
}
