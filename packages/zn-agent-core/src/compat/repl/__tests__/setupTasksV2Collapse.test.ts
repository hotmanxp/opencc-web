// @ts-nocheck
import { setupTasksV2Collapse } from '../setup/setupTasksV2Collapse.js'

describe('setupTasksV2Collapse', () => {
  it('toggle flips state', () => {
    let collapsed: boolean | null = null
    const handle = setupTasksV2Collapse({
      tasks: () => [],
      onCollapseChange: c => { collapsed = c },
    })
    expect(handle.isCollapsed()).toBe(false)
    handle.toggle()
    expect(handle.isCollapsed()).toBe(true)
    expect(collapsed).toBe(true)
    handle.teardown()
  })

  it('teardown is idempotent', () => {
    const handle = setupTasksV2Collapse({ tasks: () => [], onCollapseChange: () => {} })
    handle.teardown()
    expect(() => handle.teardown()).not.toThrow()
  })
})
