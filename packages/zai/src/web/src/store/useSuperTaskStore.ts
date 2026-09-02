import { create } from 'zustand'
import {
  fetchSuperTasks, deleteSuperTasks, setSuperTasksManaged,
  startSuperTask, pauseSuperTask, resumeSuperTask, acceptSuperTask,
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
  /** 后端 state.json 里的主管会话 id(GET /api/super-tasks 带回)。 */
  supervisorSessionId: string | null
  /** 最近一次 task_factory.created 的任务 id —— 新建任务弹窗据此显示完成条。 */
  lastCreatedTaskId: string | null
  /** 是否已成功加载过至少一次。面板的 loading 占位只应出现在首载;
   *  3s 轮询每轮都会置 loading,若不过滤会让空看板反复闪(2026-09-02 修)。 */
  loadedOnce: boolean
  load: () => Promise<void>
  deleteTasks: (ids: string[]) => Promise<void>
  setManaged: (enabled: boolean) => Promise<void>
  start: (id: string) => Promise<void>
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  accept: (id: string) => Promise<void>
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
  load: async () => {
    set({ loading: true })
    try {
      const dto = await fetchSuperTasks()
      set({
        buckets: dto.buckets,
        managed: dto.managed,
        supervisorSessionId: dto.supervisorSessionId ?? null,
        loading: false,
        loadedOnce: true,
      })
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
  start: async (id) => { await startSuperTask(id); await get().load() },
  pause: async (id) => { await pauseSuperTask(id); await get().load() },
  resume: async (id) => { await resumeSuperTask(id); await get().load() },
  accept: async (id) => { await acceptSuperTask(id); await get().load() },
  applyTaskFactoryEvent: (event) => {
    if (event.action === 'created' && typeof event.payload.id === 'string') {
      set({ lastCreatedTaskId: event.payload.id })
    }
    if (event.action === 'state.changed') {
      // 其它 tab / 后端改了托管开关或主管 sid → 同步本地
      const p = event.payload as { managedEnabled?: unknown; supervisorSessionId?: unknown }
      const patch: Partial<SuperTaskStore> = {}
      if (typeof p.managedEnabled === 'boolean') patch.managed = p.managedEnabled
      if (typeof p.supervisorSessionId === 'string') patch.supervisorSessionId = p.supervisorSessionId
      if (Object.keys(patch).length > 0) set(patch)
    }
    void get().load()
  },
  clearLastCreated: () => set({ lastCreatedTaskId: null }),
}))
