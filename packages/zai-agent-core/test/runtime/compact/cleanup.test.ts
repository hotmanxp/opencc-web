import { describe, test, expect } from 'vitest'
import {
  runPostCompactCleanup,
  markPostCompaction,
  consumePostCompactMarker,
} from '../../../src/runtime/compact/cleanup.js'

describe('cleanup', () => {
  test('runPostCompactCleanup 不抛错', () => {
    expect(() => runPostCompactCleanup('repl_main_thread')).not.toThrow()
  })

  test('markPostCompaction + consumePostCompactMarker 单次消费', () => {
    markPostCompaction()
    expect(consumePostCompactMarker()).toBe(true)
    expect(consumePostCompactMarker()).toBe(false)  // 第二次返回 false
  })

  test('consumePostCompactMarker 默认 false', () => {
    expect(consumePostCompactMarker()).toBe(false)
  })
})