// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { useInstanceStore } from './useInstanceStore.js'
import type { InstanceSnapshot } from '../../../shared/instances.js'

const baseSnap: InstanceSnapshot = {
  id: 'inst_1',
  name: 'demo',
  cwd: '/tmp/x',
  createdAt: '2026-08-03T00:00:00.000Z',
  state: 'stopped',
  port: null,
  pid: null,
  startedAt: null,
  lastHeartbeatAt: null,
  lastError: null,
  isCurrent: false,
}

describe('useInstanceStore', () => {
  it('seed sets the list', () => {
    useInstanceStore.getState().seed([{ ...baseSnap, id: 'a' }, { ...baseSnap, id: 'b' }])
    expect(useInstanceStore.getState().instances.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('applyInstanceChanged merges per id without dropping others', () => {
    useInstanceStore.getState().seed([
      { ...baseSnap, id: 'a' },
      { ...baseSnap, id: 'b' },
    ])
    useInstanceStore.getState().applyInstanceChanged({
      instanceId: 'a',
      state: 'running',
      port: 9202,
      pid: 42,
    })
    const list = useInstanceStore.getState().instances
    expect(list.find((s) => s.id === 'a')).toMatchObject({ state: 'running', port: 9202, pid: 42 })
    expect(list.find((s) => s.id === 'b')?.state).toBe('stopped')
  })

  it('applyInstanceChanged no-op for unknown id (does not crash)', () => {
    useInstanceStore.getState().seed([{ ...baseSnap, id: 'a' }])
    expect(() =>
      useInstanceStore.getState().applyInstanceChanged({
        instanceId: 'ghost',
        state: 'running',
        port: null,
        pid: null,
      }),
    ).not.toThrow()
    expect(useInstanceStore.getState().instances).toHaveLength(1)
  })
})
