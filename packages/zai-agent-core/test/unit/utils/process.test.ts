import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'node:stream'
import {
  registerProcessOutputErrorHandlers,
  __resetProcessOutputErrorHandlersForTests,
} from '../../../src/opencc-internals/utils/process.js'

function makeFakeStdout(): Writable {
  // 用普通 Writable 模拟 stdout/stderr, 强制以 EPIPE 写出.
  // 通过 .end() 关闭后, 后续 .write() 会发 'error' 事件 (code:'EPIPE').
  const w = new Writable({
    write(_chunk, _enc, cb) {
      cb()
    },
  })
  return w
}

afterEach(() => {
  __resetProcessOutputErrorHandlersForTests()
})

describe('registerProcessOutputErrorHandlers', () => {
  it('exports registerProcessOutputErrorHandlers + reset seam', () => {
    expect(typeof registerProcessOutputErrorHandlers).toBe('function')
  })

  it('silently swallows EPIPE so zai does not exit with unhandled error', () => {
    const origStdout = process.stdout
    const origStderr = process.stderr
    const fakeOut = makeFakeStdout()
    const fakeErr = makeFakeStdout()

    // 临时替换全局 stdout/stderr. registerProcessOutputErrorHandlers 注册的
    // handler 应当让 fake stream 不抛 unhandled 'error' 事件.
    Object.defineProperty(process, 'stdout', { value: fakeOut, configurable: true })
    Object.defineProperty(process, 'stderr', { value: fakeErr, configurable: true })

    let unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => unhandled.push(err)
    process.on('uncaughtException', onUnhandled)

    try {
      registerProcessOutputErrorHandlers()
      fakeOut.destroy() // 关闭后可触发 EPIPE
      fakeErr.destroy()

      // 触发 EPIPE: emit 不会被 node 内部直接派发, 我们手动派 'error'
      const e1 = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      const e2 = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      fakeOut.emit('error', e1)
      fakeErr.emit('error', e2)

      // 给微任务队列机会跑 handler
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          expect(unhandled).toEqual([])
          resolve()
        })
      })
    } finally {
      process.off('uncaughtException', onUnhandled)
      Object.defineProperty(process, 'stdout', { value: origStdout, configurable: true })
      Object.defineProperty(process, 'stderr', { value: origStderr, configurable: true })
    }
  })
})
