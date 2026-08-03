import { create } from 'zustand'
import type { InstanceSnapshot, InstanceState } from '../../../shared/instances.js'

interface InstanceStoreState {
  instances: InstanceSnapshot[]
  loading: boolean
  seed: (list: InstanceSnapshot[]) => void
  loadInstances: () => Promise<void>
  applyInstanceChanged: (e: {
    instanceId: string
    state: InstanceState
    port: number | null
    pid: number | null
  }) => void
}

export const useInstanceStore = create<InstanceStoreState>((set) => ({
  instances: [],
  loading: false,
  seed(list) {
    set({ instances: list })
  },
  async loadInstances() {
    set({ loading: true })
    try {
      const res = await fetch('/api/instances')
      if (!res.ok) return
      const data = (await res.json()) as { instances: InstanceSnapshot[] }
      set({ instances: data.instances })
    } catch {
      // keep stale list
    } finally {
      set({ loading: false })
    }
  },
  applyInstanceChanged(e) {
    set((s) => ({
      instances: s.instances.map((inst) =>
        inst.id === e.instanceId
          ? { ...inst, state: e.state, port: e.port, pid: e.pid }
          : inst,
      ),
    }))
  },
}))
