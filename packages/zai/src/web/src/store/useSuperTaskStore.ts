import { create } from 'zustand'
import {
  fetchSuperTasks, deleteSuperTasks, setSuperTasksManaged,
  startSuperTask, pauseSuperTask, resumeSuperTask, acceptSuperTask,
  resetSupervisorSession as resetSupervisorSessionApi,
} from '../lib/superTaskApi'
import type { TaskBucket } from '../lib/superTaskApi'

const EMPTY_BUCKET: TaskBucket = { queue: [], processing: [], verifying: [], finished: [] }

/** task_factory SSE 事件的局部形状(shared/events.ts TaskFactoryEvent 的子集)。 */
export interface TaskFactoryEventLike {
  action: string
  payload: Record<string, unknown>
}

export interface SuperTaskStore {
  buckets: TaskBucket
  managed: boolean
  loading: boolean
  error: string | null
  /** 后端 state.json 里的任务调度官会话 id(GET /api/super-tasks 带回)。 */
  supervisorSessionId: string | null
  /** 最近一次 task_factory.created 的任务 id —— 新建任务弹窗据此显示完成条。 */
  lastCreatedTaskId: string | null
  /** 是否已成功加载过至少一次。面板的 loading 占位只应出现在首载;
   *  2026-09-03 起带 lastHash 的轮询不再置 loading(短路轮询无抖动),
   *  首载过滤语义保持不变。 */
  loadedOnce: boolean
  /**
   * 最近一次全量响应带回的 hash(2026-09-03 快照缓存优化)。每轮 load 以
   * `?since=` 回传,服务端内容未变时短路,前端不 set 不重渲染。
   * null = 下一轮强制全量(error/resetSupervisorSession 后)。
   */
  lastHash: string | null
  load: () => Promise<void>
  deleteTasks: (ids: string[]) => Promise<void>
  setManaged: (enabled: boolean) => Promise<void>
  start: (id: string) => Promise<void>
  /**
   * 批量启动(2026-09-05,tf-dkb8gj50)。chunked 并发调单接口,Promise.allSettled
   * 统计成功/失败 → UI 反馈用。结尾统一 load 一次刷新,而不是每个 id 后都
   * load(否则 100 个 task 排队触发 100 次 GET /api/super-tasks 请求风暴)。
   */
  startMany: (ids: string[]) => Promise<{ ok: number; failed: number; errors: Array<{ id: string; message: string }> }>
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  accept: (id: string) => Promise<void>
  /**
   * 重置任务调度官会话(2026-09-02)。调后端 reset 端点清 state.json +
   * 关托管;reload 触发由调用层(window.location.reload())负责,
   * store action 保持纯净 — 其它路径(脚本/测试)若需要不 reload
   * 的版本也能直接复用。
   */
  resetSupervisorSession: () => Promise<void>
  /** SSE task_factory 事件入口(useEventStream dispatch)。 */
  applyTaskFactoryEvent: (event: TaskFactoryEventLike) => void
  clearLastCreated: () => void
}

export const useSuperTaskStore = create<SuperTaskStore>((set, get) => ({
  buckets: EMPTY_BUCKET,
  managed: false,
  loading: false,
  error: null,
  supervisorSessionId: null,
  lastCreatedTaskId: null,
  loadedOnce: false,
  lastHash: null,
  load: async () => {
    const { loadedOnce, lastHash } = get()
    // 已首载且有缓存 hash → 不置 loading(3s 轮询大概率短路,置位反而每轮抖动);
    // 首轮无 hash 走占位逻辑与旧语义一致。
    if (!loadedOnce || !lastHash) set({ loading: true })
    try {
      const dto = await fetchSuperTasks(lastHash)
      if (dto.modified === false) {
        // 服务端确认内容未变:不写 buckets/managed/sid,不触发任何 set → 无重渲染。
        return
      }
      set({
        buckets: dto.buckets,
        managed: dto.managed,
        supervisorSessionId: dto.supervisorSessionId ?? null,
        lastHash: dto.hash ?? null,
        loading: false,
        loadedOnce: true,
      })
    } catch (err) {
      // 报错后本地 hash 失效:下一轮强制全量,避免服务端短路导致持续看不到更新。
      set({ error: err instanceof Error ? err.message : String(err), loading: false, lastHash: null })
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
  resetSupervisorSession: async () => {
    await resetSupervisorSessionApi()
    // 后端已 broadcast state.changed{payload:{supervisorSessionId:null,...}},
    // SSE 触发 applyTaskFactoryEvent 会同步本地 store。这里不立即 set 其它字段,
    // 等 SSE 事件走完一遍,避免与 broadcast 抢写入时序。
    // 但服务端 sid/managed 已变、本地 hash 必然过期 → 清空强制下一轮全量。
    // reload 由 UI 层负责(让看板 / 调度官 transcript 干净同步)。
    set({ lastHash: null })
  },
  start: async (id) => { await startSuperTask(id); await get().load() },
  startMany: async (ids) => {
    // chunked 并发:每批 5 个,避免队列大时(>20)100+ 同时飞行请求打爆
    // SSE / Express。Promise.allSettled 永远 resolve → 单个 4xx/5xx 不会
    // 让整批中断,UI 用 ok/failed 报告实际成功数。
    const CONCURRENCY = 5
    const errors: Array<{ id: string; message: string }> = []
    let ok = 0
    if (ids.length === 0) {
      await get().load()
      return { ok, failed: 0, errors }
    }
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY)
      const results = await Promise.allSettled(batch.map((id) => startSuperTask(id)))
      for (let j = 0; j < results.length; j++) {
        const r = results[j]
        if (r.status === 'fulfilled') {
          ok++
        } else {
          errors.push({
            id: batch[j] as string,
            message: r.reason instanceof Error ? r.reason.message : String(r.reason),
          })
        }
      }
    }
    await get().load()
    return { ok, failed: errors.length, errors }
  },
  pause: async (id) => { await pauseSuperTask(id); await get().load() },
  resume: async (id) => { await resumeSuperTask(id); await get().load() },
  accept: async (id) => { await acceptSuperTask(id); await get().load() },
  applyTaskFactoryEvent: (event) => {
    if (event.action === 'created' && typeof event.payload.id === 'string') {
      set({ lastCreatedTaskId: event.payload.id })
    }
    if (event.action === 'state.changed') {
      // 其它 tab / 后端改了托管开关或调度官 sid → 同步本地
      const p = event.payload as { managedEnabled?: unknown; supervisorSessionId?: unknown }
      const patch: Partial<SuperTaskStore> = {}
      if (typeof p.managedEnabled === 'boolean') patch.managed = p.managedEnabled
      // 2026-09-02:reset 路由会把 supervisorSessionId 清成 null,
      // 同步接受 string | null 才能反映「未绑定」状态(否则本地仍
      // 显示旧 sid,误导 UI)。
      if (typeof p.supervisorSessionId === 'string' || p.supervisorSessionId === null) {
        patch.supervisorSessionId = p.supervisorSessionId
      }
      if (Object.keys(patch).length > 0) set(patch)
    }
    void get().load()
  },
  clearLastCreated: () => set({ lastCreatedTaskId: null }),
}))
