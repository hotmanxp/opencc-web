import { create } from 'zustand'
import {
  fetchSuperTasks, deleteSuperTasks, setSuperTasksManaged,
  startSuperTask, pauseSuperTask, resumeSuperTask, acceptSuperTask,
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
  start: async (id) => { await startSuperTask(id); await get().load() },
  pause: async (id) => { await pauseSuperTask(id); await get().load() },
  resume: async (id) => { await resumeSuperTask(id); await get().load() },
  accept: async (id) => { await acceptSuperTask(id); await get().load() },
}))