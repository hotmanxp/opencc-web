import { describe, expect, it } from 'vitest'

describe('systemApi', () => {
  it('requestRestart POSTs to /api/system/restart with reason', async () => {
    const orig = globalThis.fetch
    let called: any = null
    ;(globalThis as any).fetch = (url: string, init: any) => {
      called = { url, init }
      return Promise.resolve({ ok: true, status: 202, json: async () => ({ ok: true }) } as any)
    }
    const { requestRestart } = await import('./systemApi.js')
    const r = await requestRestart('user_action')
    expect(r.status).toBe(202)
    expect(called.url).toBe('/api/system/restart')
    expect(JSON.parse(called.init.body)).toEqual({ reason: 'user_action' })
    ;(globalThis as any).fetch = orig
  })

  it('getStatus returns parsed body on 200, null on 409', async () => {
    const orig = globalThis.fetch
    ;(globalThis as any).fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ state: 'running' }) } as any)
    const { getStatus } = await import('./systemApi.js')
    expect((await getStatus()).state).toBe('running')
    ;(globalThis as any).fetch = () => Promise.resolve({ ok: false, status: 409, json: async () => ({}) } as any)
    expect(await getStatus()).toBeNull()
    ;(globalThis as any).fetch = orig
  })
})
