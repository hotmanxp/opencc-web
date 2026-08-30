// @ts-nocheck
import { setupApiKeyVerification } from '../setup/setupApiKeyVerification.js'

describe('setupApiKeyVerification', () => {
  it('verify returns boolean and fires callback', async () => {
    const results: boolean[] = []
    const handle = setupApiKeyVerification({ onResult: ok => results.push(ok) })
    const ok = await handle.verify()
    expect(typeof ok).toBe('boolean')
    expect(results.length).toBeGreaterThanOrEqual(1)
    handle.teardown()
  })

  it('teardown is idempotent', () => {
    const handle = setupApiKeyVerification({ onResult: () => {} })
    handle.teardown()
    expect(() => handle.teardown()).not.toThrow()
  })
})
