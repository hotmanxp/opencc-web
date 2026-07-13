import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useAppStore } from './useAppStore.js'

beforeEach(() => {
  useAppStore.setState({
    connected: false,
    jobs: {},
    toasts: [],
  })
})

describe('useAppStore', () => {
  test('setConnected(true) sets connected', () => {
    useAppStore.getState().setConnected(true)
    expect(useAppStore.getState().connected).toBe(true)
  })

  test('applyJobEvent for job.started registers job', () => {
    useAppStore.getState().applyJobEvent({
      type: 'job.started',
      eventId: 'e1', ts: 1,
      jobId: 'j1', kind: 'resource_refresh',
    })
    expect(useAppStore.getState().jobs.j1.kind).toBe('resource_refresh')
  })

  test('applyJobEvent for job.progress updates progress', () => {
    useAppStore.getState().applyJobEvent({
      type: 'job.started',
      eventId: 'e1', ts: 1,
      jobId: 'j1', kind: 'install',
    })
    useAppStore.getState().applyJobEvent({
      type: 'job.progress',
      eventId: 'e2', ts: 2,
      jobId: 'j1', message: 'half', percent: 50,
    })
    expect(useAppStore.getState().jobs.j1.progress).toBe(50)
    expect(useAppStore.getState().jobs.j1.message).toBe('half')
  })

  test('applyJobEvent for job.done removes job after delay', () => {
    vi.useFakeTimers()
    useAppStore.getState().applyJobEvent({
      type: 'job.started',
      eventId: 'e1', ts: 1,
      jobId: 'j1', kind: 'install',
    })
    useAppStore.getState().applyJobEvent({
      type: 'job.done',
      eventId: 'e2', ts: 2, jobId: 'j1',
    })
    // immediate still present; cleared after 3s
    expect(useAppStore.getState().jobs.j1).toBeDefined()
    vi.advanceTimersByTime(3000)
    expect(useAppStore.getState().jobs.j1).toBeUndefined()
    vi.useRealTimers()
  })

  test('applySystemEvent toast pushes toast', () => {
    useAppStore.getState().applySystemEvent({
      type: 'toast', eventId: 'e1', ts: 1, level: 'info', message: 'hi',
    })
    expect(useAppStore.getState().toasts.length).toBe(1)
    expect(useAppStore.getState().toasts[0].message).toBe('hi')
  })

  test('applySystemEvent server.error pushes error toast', () => {
    useAppStore.getState().applySystemEvent({
      type: 'server.error', eventId: 'e1', ts: 1, message: 'oops',
    })
    expect(useAppStore.getState().toasts[0].level).toBe('error')
  })
})
