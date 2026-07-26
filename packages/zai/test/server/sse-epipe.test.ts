import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { Router } from 'express'
import { writeSse } from '../../src/server/services/sse.js'

// Mock req/res to simulate a closed socket: res.write throws EPIPE,
// res.writableEnded should be honored so subsequent writes are no-ops.
function makeFakeRes() {
  let closed = false
  let writeCalls = 0
  let endCalled = false
  const errs: unknown[] = []
  const fake: any = {
    setHeader() {},
    flushHeaders() {},
    on(_ev: string, _cb: (...args: unknown[]) => void) {},
    write(chunk: unknown) {
      writeCalls += 1
      if (closed) {
        const e = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
        errs.push(e)
        throw e
      }
      // success
      return true
    },
    end() {
      endCalled = true
    },
    get closed() {
      return closed
    },
    closeSocket() {
      closed = true
    },
    get writeCalls() {
      return writeCalls
    },
    get endCalled() {
      return endCalled
    },
    errs,
  }
  return fake
}

describe('writeSse EPIPE resilience', () => {
  it('does not throw when res.write raises EPIPE after client disconnect', () => {
    const res = makeFakeRes()
    res.closeSocket()
    expect(() => writeSse(res, { type: 'test', foo: 1 })).not.toThrow()
  })

  it('still buffers first write when socket open and skips later writes', () => {
    const res = makeFakeRes()
    writeSse(res as any, { type: 'first', value: 1 })
    expect(res.writeCalls).toBe(2) // event + data (no seq)
    // close + retry → should not throw and not call underlying write again
    res.closeSocket()
    expect(() => writeSse(res as any, { type: 'second' })).not.toThrow()
  })
})
