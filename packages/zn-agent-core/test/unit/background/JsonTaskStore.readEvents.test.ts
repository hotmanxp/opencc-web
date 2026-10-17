/**
 * 回归测试 — readEvents 的 stream 错误必须交给调用方,不得逃逸 (wb-008)。
 *
 * 缺陷:`stream.on('error')` 回调里直接 `throw err`。emit 栈不属于任何
 * async 上下文,该 throw 变成进程级 uncaughtException:
 *   - `processGuards` 明确不注册 `uncaughtException` 兜底 → 直接杀进程
 *   - 调用方的 `for await (const ev of store.readEvents(...))` **永远收不到
 *     终态**,async generator 既不 yield 也不 return,调用方挂死
 *
 * 实测(修复前,`events/boom.log` 是目录 → 读它触发 EISDIR):
 *   Test timed out in 30000ms        ← 调用方挂死
 *   Unhandled Error: EISDIR          ← 错误逃逸成进程级异常
 *
 * 修法:`else throw err` → `else stream.destroy(err)`,让错误经
 * `for await (const line of rl)` 的正常 rejection 路径抛给调用方。
 *
 * ⚠️ ENOENT 的既有语义必须不变:事件文件不存在视为「没有事件」,静默返回。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonTaskStore } from '../../../src/compat/background/store/JsonTaskStore.js'

let dir: string
let store: JsonTaskStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'json-task-store-'))
  store = new JsonTaskStore(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('JsonTaskStore.readEvents — 错误必须可被调用方捕获 (wb-008)', () => {
  it('事件文件不存在时静默返回(既有语义不得回归)', async () => {
    const seen: unknown[] = []
    for await (const ev of store.readEvents('nope')) seen.push(ev)
    expect(seen).toEqual([])
  })

  it('读取出错时以 rejection 抛给调用方,而不是挂死', async () => {
    // 把事件路径造成目录 → 读它必 EISDIR,且这个错误不是 ENOENT
    mkdirSync(join(dir, 'events', 'boom.log'), { recursive: true })

    const collected: unknown[] = []
    // 修复前这里会 30s 超时:async generator 既不 yield 也不 return,
    // 调用方的 for-await 永远等不到终态。
    await expect(
      (async () => {
        for await (const ev of store.readEvents('boom')) collected.push(ev)
      })(),
    ).rejects.toThrow()

    expect(collected).toEqual([])
  }, 10_000)
})
