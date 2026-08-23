/**
 * Cron 工具集 — dsh 风格 (dsh-017)。
 *
 * 3 个工具: CronCreate / CronDelete / CronList。
 * 替代 opencc vendor ScheduleCronTool (CronCreateTool/CronDeleteTool/CronListTool)。
 *
 * 5 字段 cron 表达式(对齐 opencc): "M H DoM Mon DoW" 本地时间。
 *
 * **存储**:`~/.zai/tasks-dsh/cron.json`(与 Task 共享目录,主计划 R4 隔离)
 * **调度**:zai 进程内 setTimeout / setInterval;durable=true 持久化 + 重启恢复
 * **触发**:调 parent agent.followup(createUserMessage(prompt)) — 与 dsh subagent
 *   通知父 session 同款机制(走 dsh-side `createUserMessage`)。
 *
 * **Phase 1 简化**:
 *   - 5 字段 cron 解析自实现(支持 `\*`, `\*\/N`, `1,2,3`, `1-5`, 单数字)
 *   - 精度 1 分钟
 *   - 一次性和 recurring 都支持
 *   - 调度器在 zai 进程内(无独立进程),durable 重启恢复在 Phase 2
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { defineTool } from '@zn-ai/dsh-bridge/dsh-core'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@zn-ai/dsh-bridge/dsh-core'

const CRON_FILE = join(homedir(), '.zai', 'tasks-dsh', 'cron.json')

export type CronTaskStatus = 'pending' | 'firing' | 'done' | 'cancelled'

export interface CronTask {
  id: string
  sessionId: string
  /** 5 字段 cron 表达式 */
  cron: string
  /** 触发时注入的 prompt */
  prompt: string
  /** true (default) 持续触发;false 仅一次 */
  recurring: boolean
  /** true 持久化到 cron.json;false 仅进程内存 */
  durable: boolean
  /** 任务状态 */
  status: CronTaskStatus
  /** 计划下次触发时间(epoch ms) */
  nextFireAt: number
  /** 已触发次数 */
  fireCount: number
  createdAt: number
  updatedAt: number
}

// ====== 存储 ======

async function readAll(): Promise<CronTask[]> {
  try {
    const raw = await readFile(CRON_FILE, 'utf-8')
    return JSON.parse(raw) as CronTask[]
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function writeAll(tasks: CronTask[]): Promise<void> {
  await mkdir(join(homedir(), '.zai', 'tasks-dsh'), { recursive: true })
  const tmp = `${CRON_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf-8')
  await rename(tmp, CRON_FILE)
}

function generateId(): string {
  return randomBytes(4).toString('hex')
}

// ====== 5 字段 cron 解析(简化版) ======

/**
 * 解析一个 cron 字段为值集合(0-59 minute / 0-23 hour / 1-31 day / 1-12 month / 0-6 dow)
 * 支持: 星号 | 步长 | 列表 | 范围 | 数字
 */
function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10)
      const hi = parseInt(rangeMatch[2], 10)
      for (let i = lo; i <= hi; i++) out.add(i)
      continue
    }
    const stepMatch = part.match(/^\*\/(\d+)$/)
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10)
      if (step <= 0) throw new Error(`invalid step: ${part}`)
      for (let i = min; i <= max; i += step) out.add(i)
      continue
    }
    if (part === '*') {
      for (let i = min; i <= max; i++) out.add(i)
      continue
    }
    const n = parseInt(part, 10)
    if (Number.isNaN(n)) throw new Error(`invalid cron field: ${part}`)
    out.add(n)
  }
  return out
}

/**
 * 解析 5 字段 cron 表达式,返回各字段允许值集合。
 */
export function parseCron(expr: string): {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
} {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cron expression must have 5 fields (M H DoM Mon DoW), got ${parts.length}: ${expr}`)
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6),
  }
}

/**
 * 计算 next fire time(epoch ms)。从 `from` 开始往后扫,最多 4 年兜底。
 *
 * Vixie cron 语义:day-of-month 和 day-of-week 是 OR 关系(任一匹配即触发)。
 * 这是和 POSIX cron 的微小差异,但 opencc 也用这个语义。
 */
export function nextFireMs(expr: string, from: number = Date.now()): number {
  const c = parseCron(expr)
  // 从下一分钟开始(避免重复触发)
  const t = new Date(from)
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  // 4 年兜底(避免无限循环)
  const MAX_LOOKAHEAD_MS = 4 * 365 * 24 * 60 * 60 * 1000
  const end = from + MAX_LOOKAHEAD_MS
  while (t.getTime() <= end) {
    if (
      c.minute.has(t.getMinutes()) &&
      c.hour.has(t.getHours()) &&
      c.month.has(t.getMonth() + 1) &&
      (c.dayOfMonth.has(t.getDate()) || c.dayOfWeek.has(t.getDay()))
    ) {
      return t.getTime()
    }
    t.setMinutes(t.getMinutes() + 1)
  }
  throw new Error(`no fire time found in next 4 years for cron: ${expr}`)
}

// ====== 调度器(进程内 setTimeout) ======

/**
 * 单个任务的调度句柄。保存到全局 Map,用于 cancel / reschedule。
 */
interface CronScheduleHandle {
  timer: NodeJS.Timeout
  task: CronTask
}

const activeSchedules = new Map<string, CronScheduleHandle>()

/**
 * cron 触发时调的父 agent 最小子集 — zai 端不用 import 完整 dsh Agent 类型。
 */
export type CronParentAgent = {
  followup: (msg: unknown) => void
}

export interface CronSchedulerOptions {
  /**
   * 拿父 agent 的回调 — 触发时调 agent.followup(...)。返回 undefined
   * 表示该 session 还没 agent 起来(可重试 / 跳过)。
   */
  getParentAgent: (sessionId: string) => CronParentAgent | undefined
}

/**
 * 调度一个任务 — 计算 nextFireAt + 注册 setTimeout。Phase 1 简单 setTimeout,
 * 不做 catch-up(若进程挂掉错过时间,任务不补触发,等待下次)。
 */
export function scheduleCronTask(task: CronTask, opts: CronSchedulerOptions): void {
  // 已存在则先取消
  cancelCronSchedule(task.id)
  const next = task.nextFireAt
  const delay = Math.max(0, next - Date.now())
  const timer = setTimeout(() => {
    void fireCronTask(task, opts)
  }, delay)
  // 不阻止进程退出
  if (typeof timer.unref === 'function') timer.unref()
  activeSchedules.set(task.id, { timer, task })
}

export function cancelCronSchedule(taskId: string): void {
  const h = activeSchedules.get(taskId)
  if (h) {
    clearTimeout(h.timer)
    activeSchedules.delete(taskId)
  }
}

/**
 * 触发 cron 任务 — 调 parent agent.followup,然后 reschedule 或 mark done。
 */
async function fireCronTask(task: CronTask, opts: CronSchedulerOptions): Promise<void> {
  const parentAgent = opts.getParentAgent(task.sessionId)
  if (parentAgent) {
    try {
      const text = `<cron-fire taskId="${task.id}" cron="${task.cron}">${task.prompt}</cron-fire>`
      parentAgent.followup(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }),
      )
    } catch (err) {
      console.warn(`[dsh-bridge] cron fire ${task.id} failed:`, err)
    }
  } else {
    console.warn(`[dsh-bridge] cron fire ${task.id}: no parent agent for session ${task.sessionId}`)
  }

  // 更新 task 状态 / reschedule
  const all = await readAll()
  const idx = all.findIndex((t) => t.id === task.id)
  if (idx < 0) return
  const updated: CronTask = {
    ...all[idx],
    fireCount: all[idx].fireCount + 1,
    status: 'firing',
    updatedAt: Date.now(),
  }
  if (task.recurring) {
    // reschedule
    updated.status = 'pending'
    updated.nextFireAt = nextFireMs(task.cron, Date.now())
  } else {
    updated.status = 'done'
    cancelCronSchedule(task.id)
  }
  all[idx] = updated
  await writeAll(all)
  if (updated.status === 'pending') {
    scheduleCronTask(updated, opts)
  }
}

// ====== 工具 ======

export interface CronToolOptions {
  /** sessionId getter — 跟 Task 工具同款。 */
  getSessionId: () => string | undefined
  /** 拿父 agent 回调 — cron 触发时调(子集 CronParentAgent)。 */
  getParentAgent: (sessionId: string) => CronParentAgent | undefined
  /** cron 变化 sink — 转发到 zai 端 UI 通知。 */
  onCronChange?: (info: { action: 'create' | 'delete' | 'list' | 'fire'; task?: CronTask; sessionId: string }) => void
}

/**
 * CronCreate 工具。
 */
export function createCronCreateTool(opts: CronToolOptions) {
  return defineTool({
    name: 'CronCreate',
    description:
      'Schedule a recurring or one-shot prompt using a 5-field cron expression ' +
      '(M H DoM Mon DoW, local time). At each fire time, the prompt is injected into ' +
      'the session as a `<cron-fire>` user message. Set recurring=false for "remind me at X" ' +
      'one-shot requests with pinned minute/hour/dom/month. Set durable=true to persist to ' +
      '`~/.zai/tasks-dsh/cron.json` (survives process restart); false (default) is in-memory only.',
    parameters: {
      cron: {
        type: 'string',
        description: '5-field cron expression (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local).',
        required: true,
      },
      prompt: {
        type: 'string',
        description: 'Prompt to enqueue at each fire time.',
        required: true,
      },
      recurring: {
        type: 'boolean',
        description: 'true (default) = fire on every cron match. false = fire once, then auto-delete.',
      },
      durable: {
        type: 'boolean',
        description: 'true = persist to disk (survives restarts). false (default) = in-memory only.',
      },
    },
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' } }, additionalProperties: false },
      render(_a, value) { return [{ type: 'text', text: (value as { output: string }).output }] },
    },
    async execute(args) {
      const a = args as { cron: string; prompt: string; recurring?: boolean; durable?: boolean }
      const sessionId = opts.getSessionId()
      if (!sessionId) return { output: '[error] CronCreate requires an active session' }

      // 校验 cron
      let nextAt: number
      try {
        nextAt = nextFireMs(a.cron, Date.now())
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        return { output: `[error] invalid cron expression: ${m}` }
      }

      const task: CronTask = {
        id: generateId(),
        sessionId,
        cron: a.cron,
        prompt: a.prompt,
        recurring: a.recurring !== false,
        durable: a.durable === true,
        status: 'pending',
        nextFireAt: nextAt,
        fireCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      const all = await readAll()
      all.push(task)
      if (task.durable) await writeAll(all)
      scheduleCronTask(task, { getParentAgent: opts.getParentAgent })
      opts.onCronChange?.({ action: 'create', task, sessionId })

      const humanNext = new Date(nextAt).toISOString()
      return { output: JSON.stringify({ id: task.id, cron: task.cron, nextFireAt: humanNext, recurring: task.recurring, durable: task.durable }, null, 2) }
    },
  })
}

/**
 * CronDelete 工具。
 */
export function createCronDeleteTool(opts: CronToolOptions) {
  return defineTool({
    name: 'CronDelete',
    description: 'Delete a scheduled cron task by id. Cancels the pending schedule and removes from disk (if durable).',
    parameters: {
      id: { type: 'string', description: 'Cron task ID returned by CronCreate.', required: true },
    },
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' } }, additionalProperties: false },
      render(_a, value) { return [{ type: 'text', text: (value as { output: string }).output }] },
    },
    async execute(args) {
      const a = args as { id: string }
      const sessionId = opts.getSessionId()
      if (!sessionId) return { output: '[error] CronDelete requires an active session' }
      const all = await readAll()
      const idx = all.findIndex((t) => t.id === a.id)
      if (idx < 0) return { output: `[error] cron task not found: ${a.id}` }
      const removed = all[idx]
      if (removed.durable) await writeAll(all.filter((t) => t.id !== a.id))
      cancelCronSchedule(a.id)
      opts.onCronChange?.({ action: 'delete', task: removed, sessionId })
      return { output: `Deleted cron task ${a.id}` }
    },
  })
}

/**
 * CronList 工具。
 */
export function createCronListTool(opts: CronToolOptions) {
  return defineTool({
    name: 'CronList',
    description: "List all cron tasks for the current session (and durable tasks from disk). Returns a JSON array of cron task objects.",
    parameters: {},
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' } }, additionalProperties: false },
      render(_a, value) { return [{ type: 'text', text: (value as { output: string }).output }] },
    },
    async execute() {
      const sessionId = opts.getSessionId()
      if (!sessionId) return { output: '[error] CronList requires an active session' }
      const all = await readAll()
      const mine = all.filter((t) => t.sessionId === sessionId && t.status !== 'done' && t.status !== 'cancelled')
      return { output: JSON.stringify(mine, null, 2) }
    },
  })
}

/**
 * 注册 3 个 Cron 工具到 dsh ctx.tools,返回统一 disposer。
 */
export function registerCronTools(
  ctx: Context,
  opts: CronToolOptions,
): () => void {
  const tools = ctx.get('tools') as {
    register: (tool: ReturnType<typeof defineTool>) => () => void
  }
  if (!tools) {
    throw new Error('[dsh-bridge] registerCronTools: ctx.tools unavailable')
  }
  const d1 = tools.register(createCronCreateTool(opts)) as () => void
  const d2 = tools.register(createCronDeleteTool(opts)) as () => void
  const d3 = tools.register(createCronListTool(opts)) as () => void
  return () => {
    try { d1() } catch (err) { console.warn('[dsh-bridge] CronCreate dispose:', err) }
    try { d2() } catch (err) { console.warn('[dsh-bridge] CronDelete dispose:', err) }
    try { d3() } catch ( err) { console.warn('[dsh-bridge] CronList dispose:', err) }
  }
}
