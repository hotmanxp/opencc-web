// @ts-nocheck
import { setupCostSummary } from '../setup/setupCostSummary.js'

describe('setupCostSummary', () => {
  it('refresh fires onUpdate', async () => {
    const calls: any[] = []
    const handle = setupCostSummary({ onUpdate: s => calls.push(s) })
    await handle.refresh()
    expect(calls.length).toBeGreaterThanOrEqual(1)
    handle.teardown()
  })

  it('teardown is idempotent', () => {
    const handle = setupCostSummary({ onUpdate: () => {} })
    handle.teardown()
    expect(() => handle.teardown()).not.toThrow()
  })
})
