import type { ChildProcess } from 'node:child_process';
import type * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupAndExit,
  closeServer,
  exit,
  registerHttpServer,
  registerViteProcess,
  sendRestart,
  __getRegisteredServerForTests,
  __resetRuntimeLifecycleForTests,
} from '../../src/server/services/runtimeLifecycle.js'

class FakeServer {
  private _emitter = new EventEmitter()
  closed = false
  close(cb?: () => void) {
    this.closed = true
    queueMicrotask(() => {
      this._emitter.emit('close')
      cb?.()
    })
  }
  on(ev: string, cb: () => void) {
    this._emitter.on(ev, cb)
    return this
  }
}

beforeEach(() => {
  __resetRuntimeLifecycleForTests()
  delete process.env.ZAI_SUPERVISOR_PID
})

afterEach(() => {
  __resetRuntimeLifecycleForTests()
  delete process.env.ZAI_SUPERVISOR_PID
  vi.restoreAllMocks()
  // 清理 process.send mock,免得污染别的测试文件
  delete (process as { send?: unknown }).send
})

describe('runtimeLifecycle.registerHttpServer', () => {
  it('registers the server so closeServer can close it', async () => {
    const server = new FakeServer() as unknown as http.Server
    registerHttpServer(server as http.Server)
    expect(__getRegisteredServerForTests()?.server).toBe(server)
    await closeServer()
    expect((server as unknown as FakeServer).closed).toBe(true)
  })

  it('overwrites a previous registration (test seam)', () => {
    const a = new FakeServer() as unknown as http.Server
    const b = new FakeServer() as unknown as http.Server
    registerHttpServer(a)
    registerHttpServer(b)
    expect(__getRegisteredServerForTests()?.server).toBe(b)
  })
})

describe('runtimeLifecycle.closeServer', () => {
  it('returns immediately when no server is registered', async () => {
    await expect(closeServer()).resolves.toBeUndefined()
  })

  it('uses forceCloseAllConnections when registered (production path)', async () => {
    let calledAll = false
    class ForceServer extends FakeServer {
      override close(cb?: () => void) {
        calledAll = false
        super.close(cb)
      }
      closeAllConnections() {
        calledAll = true
      }
    }
    const server = new ForceServer() as unknown as http.Server
    registerHttpServer(server as http.Server, { forceCloseAllConnections: true })
    await closeServer()
    // closeAllConnections 必须在 server.close callback 之前/同时触发,
    // 否则 keep-alive socket 会阻塞 supervisor 重启 child。
    expect(calledAll).toBe(true)
  })
})

describe('runtimeLifecycle.registerViteProcess', () => {
  it('kills vite child when closeServer runs', async () => {
    const child = new EventEmitter() as unknown as ChildProcess
    let killed = false
    ;(child as unknown as { kill: (sig?: string) => boolean }).kill = () => {
      killed = true
      ;(child as unknown as { killed: boolean }).killed = true
      return true
    }
    registerViteProcess(child)
    await closeServer()
    expect(killed).toBe(true)
  })

  it('skips kill if vite already dead', async () => {
    const child = new EventEmitter() as unknown as ChildProcess
    let killCalls = 0
    ;(child as unknown as { kill: (sig?: string) => boolean }).kill = () => {
      killCalls++
      ;(child as unknown as { killed: boolean }).killed = true
      return true
    }
    ;(child as unknown as { killed: boolean }).killed = true
    registerViteProcess(child)
    await closeServer()
    expect(killCalls).toBe(0)
  })
})

describe('runtimeLifecycle.sendRestart', () => {
  it('sends {type:"restart",reason} to supervisor (not "restarted")', () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    let captured: unknown = null
    ;(process as { send?: (m: unknown) => boolean }).send = (m) => {
      captured = m
      return true
    }
    const ok = sendRestart('user_action')
    expect(ok).toBe(true)
    expect(captured).toEqual({ type: 'restart', reason: 'user_action' })
  })

  it('returns false when not managed (env unset)', () => {
    delete process.env.ZAI_SUPERVISOR_PID
    let called = false
    ;(process as { send?: (m: unknown) => boolean }).send = () => {
      called = true
      return true
    }
    const ok = sendRestart('auto_recovery')
    expect(ok).toBe(false)
    expect(called).toBe(false)
  })

  it('returns false when process.send is unavailable', () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    delete (process as { send?: unknown }).send
    const ok = sendRestart('update')
    expect(ok).toBe(false)
  })
})

describe('runtimeLifecycle.exit', () => {
  it('calls process.exit with the given code', () => {
    const spy = vi.spyOn(process, 'exit').mockImplementation(() => undefined)
    exit(0)
    expect(spy).toHaveBeenCalledWith(0)
  })
})

describe('runtimeLifecycle.cleanupAndExit', () => {
  it('runs closeServer then exits', async () => {
    const server = new FakeServer() as unknown as http.Server
    registerHttpServer(server as http.Server)
    const spy = vi.spyOn(process, 'exit').mockImplementation(() => undefined)
    await cleanupAndExit(0)
    expect((server as unknown as FakeServer).closed).toBe(true)
    expect(spy).toHaveBeenCalledWith(0)
  })
})