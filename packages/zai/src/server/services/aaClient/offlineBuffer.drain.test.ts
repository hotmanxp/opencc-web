/**
 * 回归测试 — 离线通知补发不得静默销毁 (tc-001)。
 *
 * 缺陷:`maybeDrain()` 发完全部条目后 `writeFile(path, '')` **整体清空**
 * outbox,而紧邻其上的注释写着「If sendNotification silently dropped ...
 * the next tick re-reads the file and re-enqueues」—— 注释与代码直接矛盾,
 * 文件已被清空,重读无从发生。
 *
 * 两条都会丢的路径:
 *   1. **补发中途掉线**:第 3 条发出时连接已断,`sendNotification` 内部走
 *      `queueOffline` 重新入队(它自己 append 回同一文件),随后 drain 的
 *      整体清空把它连同重入队的那份一起抹掉。不依赖外部并发。
 *   2. 并发 enqueue:drain 读文件期间新条目被 append,drain 结束时一并清空。
 *
 * 修法:只删除**已成功发送的行前缀**,而不是整体清空。
 *
 * 影响面:`initAaClient` 受 `isAaEnabled()` 把关,只有 `--aa` 启动的实例
 * 有这个 buffer —— 但对这类实例是静默丢消息(通知永久销毁)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SAVED_ZAI_DATA_DIR = process.env.ZAI_DATA_DIR

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aa-offlinebuf-'))
  process.env.ZAI_DATA_DIR = dataDir
  vi.resetModules()
})

afterEach(() => {
  if (SAVED_ZAI_DATA_DIR === undefined) delete process.env.ZAI_DATA_DIR
  else process.env.ZAI_DATA_DIR = SAVED_ZAI_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

/** 最小 AaConnection 替身:可控状态 + 记录已发送条目。 */
function makeConn(options: { flipAfter?: number } = {}) {
  const sent: Array<{ method: string; payload: unknown }> = []
  let connected = true
  let sends = 0
  return {
    sent,
    getStatus: () => ({ state: connected ? 'connected' : 'closed' }),
    sendNotification(method: string, payload: unknown) {
      sends++
      // 模拟「发到第 N 条时连接掉线」:之后 sendNotification 不再真正送达,
      // 生产实现此时会走 queueOffline 把条目 append 回同一文件。
      if (options.flipAfter !== undefined && sends > options.flipAfter) {
        connected = false
        return
      }
      sent.push({ method, payload })
    },
    isConnected: () => connected,
  }
}

async function loadBuffer() {
  const { OfflineBuffer } = await import('./offlineBuffer.js')
  const { ensureAaDir, aaOutboxPath } = await import('../paths.js')
  await ensureAaDir()
  return { OfflineBuffer, aaOutboxPath }
}

describe('OfflineBuffer.maybeDrain — 不得静默销毁未送达的通知 (tc-001)', () => {
  it('全量送达时清空 outbox', async () => {
    const { OfflineBuffer, aaOutboxPath } = await loadBuffer()
    const buf = new OfflineBuffer(makeConn() as never, 9911)
    await buf.enqueue('a', { n: 1 })
    await buf.enqueue('b', { n: 2 })

    const replayed = await buf.maybeDrain()
    expect(replayed).toBe(2)
    expect(readFileSync(aaOutboxPath(9911), 'utf-8').trim()).toBe('')
  })

  it('补发中途掉线:未送达的条目必须留在 outbox 里等下次 tick', async () => {
    const { OfflineBuffer, aaOutboxPath } = await loadBuffer()
    const conn = makeConn({ flipAfter: 2 }) // 前 2 条送达,第 3 条起断
    const buf = new OfflineBuffer(conn as never, 9912)
    for (let i = 1; i <= 5; i++) await buf.enqueue('m', { n: i })

    await buf.maybeDrain()

    // 连接此刻已断,但 outbox 里必须还留着第 3~5 条 ——
    // 修复前这里是空文件,三条通知被静默销毁。
    const left = readFileSync(aaOutboxPath(9912), 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { payload: { n: number } }).payload.n)

    expect(left).toEqual([3, 4, 5])
  })

  it('并发 enqueue:drain 期间新入队的条目不得被整体清空', async () => {
    const { OfflineBuffer, aaOutboxPath } = await loadBuffer()
    const buf = new OfflineBuffer(makeConn() as never, 9913)
    await buf.enqueue('old', { n: 0 })

    // 复刻生产里的真实时序:`sendNotification` 发现未连接时走
    // `void this.queueOffline(...)`,而 queueOffline 内部又 import 本模块
    // 调 enqueue —— 那次 enqueue 是 fire-and-forget,排在 drain 的重写**之后**。
    // 曾经在这里丢条目:只按「读完时的快照」重写,就把它抹掉了。
    let self!: InstanceType<typeof OfflineBuffer>
    self = new OfflineBuffer(
      {
        getStatus: () => ({ state: 'connected' as const }),
        sendNotification() {
          void self.enqueue('new', { n: 99 })
        },
      } as never,
      9913,
    )
    await self.maybeDrain()
    // 等 fire-and-forget 的 enqueue 真正落盘
    await new Promise((r) => setTimeout(r, 50))

    const left = readFileSync(aaOutboxPath(9913), 'utf-8')
    expect(left).toContain('new')
  })

  it('损坏行被丢弃,但不牵连同批次的正常条目', async () => {
    const { OfflineBuffer, aaOutboxPath } = await loadBuffer()
    const buf = new OfflineBuffer(makeConn() as never, 9914)
    await buf.enqueue('good1', { n: 1 })
    await buf.enqueue('good2', { n: 2 })

    // 手工插一行损坏 JSON 到文件中间
    const p = aaOutboxPath(9914)
    const { appendFile } = await import('node:fs/promises')
    await appendFile(p, '{not json\n', 'utf-8')

    const replayed = await buf.maybeDrain()
    expect(replayed).toBe(2)
    // 两条正常条目都已发出 → 文件此时才该清空
    expect(readFileSync(p, 'utf-8').trim()).toBe('')
    expect(existsSync(p)).toBe(true)
  })
})
