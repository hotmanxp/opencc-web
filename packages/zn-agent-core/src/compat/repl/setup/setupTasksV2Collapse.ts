// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P2): L2 hook adapter — setupTasksV2Collapse.
 * Imperative tasks list collapse/expand state; mirrors useTasksV2WithCollapseEffect.
 */

type SetupTasksV2CollapseOpts = {
  tasks: () => any[]
  onCollapseChange: (collapsed: boolean) => void
}

export function setupTasksV2Collapse(opts: SetupTasksV2CollapseOpts) {
  let collapsed = false
  let disposed = false
  return {
    toggle() {
      if (disposed) return
      collapsed = !collapsed
      try { opts.onCollapseChange(collapsed) } catch (e) { console.warn(e) }
    },
    isCollapsed: () => collapsed,
    setCollapsed(v: boolean) {
      if (disposed || collapsed === v) return
      collapsed = v
      try { opts.onCollapseChange(collapsed) } catch (e) { console.warn(e) }
    },
    teardown() {
      if (disposed) return
      disposed = true
    },
  }
}
