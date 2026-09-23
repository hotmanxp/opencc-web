// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../../src/web/src/store/useAppStore.js'

// 模块加载瞬间的初始快照 —— 这才是 create() 给的默认值，不受后面 setState 影响。
const initialArchiveKeepCount = useAppStore.getState().archiveKeepCount

afterEach(() => {
  useAppStore.setState({ archiveKeepCount: 20 })
})

describe('useAppStore.archiveKeepCount', () => {
  it('默认 20（与服务端 resolveArchiveKeepCount 的回落值一致）', () => {
    expect(initialArchiveKeepCount).toBe(20)
  })

  it('setArchiveKeepCount 写入 store', () => {
    useAppStore.getState().setArchiveKeepCount(42)
    expect(useAppStore.getState().archiveKeepCount).toBe(42)
  })
})
