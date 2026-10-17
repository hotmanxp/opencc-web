/**
 * 回归测试 — `enforceSizeCap` 的整文件重写不得吃掉别的进程并发追加的行 (cl-002)。
 *
 * 背景:凡 argv 带 `--aa` 的 zai 进程(root 与各 child,见 `instanceSupervisor`
 * 的「子进程 env 说开 AA ⟺ argv 有 --aa」不变式)各自持有一个
 * `OfflineBuffer`,port 恒为 0,于是**都指向同一个 `outbox-0.jsonl`**;
 * 而 `io` 互斥是**进程内**的 Promise 链,跨进程为零。
 *
 * 于是「读文件 → 按大小裁剪 → 整文件重写」这条路径没有重读合并:别的进程
 * 在这个 read→write 窗口里 append 的通知会被整块抹掉 —— 而 FIFO 裁剪的本意
 * 只是丢**最老**的。
 *
 * `maybeDrain` 的末尾**早就有**重读合并(`stillThere` / `appended`),
 * 是 tc-001 修复时建立的;这条路径当时漏了。本批把它对齐。
 *
 * 测试手法:`enforceSizeCap` 在 `io` 互斥内,**单进程内插不进并发写**,
 * 所以这里 mock `fs` 按调用次序返回不同内容 —— 直接验证「发生了重读,且
 * 新增行被合并进最终写入」,不依赖时序碰运气。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SAVED_ZAI_DATA_DIR = process.env.ZAI_DATA_DIR
const SAVED_MAX_MB = process.env.ZAI_AA_OUTBOX_MAX_MB

// OLD:超出上限的旧快照(每行 ~66 字节 × 5 行;上限设成 104 字节)
const OLD_LINES = Array.from({ length: 5 }, (_, i) =>
  JSON.stringify({ method: 'old', payload: { i, pad: 'x'.repeat(40) } }),
)
const OLD = OLD_LINES.join('\n')
// NEW:别的进程在 read→write 窗口里追加的两行
const APPENDED = [
  JSON.stringify({ method: 'timeline.itemUpsert', payload: { from: 'other-process' } }),
  JSON.stringify({ method: 'notice.upserted', payload: { from: 'other-process-2' } }),
]
const NEW = [OLD, ...APPENDED].join('\n')

const OUTBOX = '/tmp/aa-sizecap-test/aa/outbox-0.jsonl'
const MAX_BYTES = 104 // ZAI_AA_OUTBOX_MAX_MB = 0.0001

let readCalls = 0
let written: string | null = null
/** 由各用例设置,决定 mock 的 stat 是否报超限。 */
let statSize = 0

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(async (p: unknown, _enc?: unknown) => {
      if (String(p).endsWith('outbox-0.jsonl')) {
        readCalls++
        // 第一次 = 旧快照(裁剪用);第二次 = 重读(含并发新增)
        return readCalls === 1 ? OLD : NEW
      }
      return actual.readFile(p as never)
    }),
    stat: vi.fn(async (p: unknown) => {
      if (String(p).endsWith('outbox-0.jsonl')) return { size: statSize } as never
      return actual.stat(p as never)
    }),
    writeFile: vi.fn(async (p: unknown, data: unknown) => {
      if (String(p).endsWith('outbox-0.jsonl')) written = String(data)
      return actual.writeFile(p as never, data as never)
    }),
  }
})

// `existsSync` 走真实 fs 会因测试路径不存在而 false,重读分支永远进不去。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (p: unknown) =>
      String(p).endsWith('outbox-0.jsonl') ? true : actual.existsSync(p as never),
  }
})

function makeConn() {
  return {
    getStatus: () => ({ state: 'disconnected' }),
    sendNotification: () => {},
  }
}

/** 直接打私有方法 —— `enqueue` 会先 `appendFile` 真实写盘,污染 mock 计数。 */
async function callEnforceSizeCap(maxMb: string): Promise<void> {
  process.env.ZAI_AA_OUTBOX_MAX_MB = maxMb
  vi.resetModules()
  const { OfflineBuffer } = await import('./offlineBuffer.js')
  const buf = new OfflineBuffer(makeConn() as never, 0)
  await (buf as unknown as { enforceSizeCap: (p: string) => Promise<void> }).enforceSizeCap(OUTBOX)
}

describe('offlineBuffer — enforceSizeCap 的并发安全 (cl-002)', () => {
  beforeEach(() => {
    readCalls = 0
    written = null
    statSize = OLD.length + 10_000 // 默认强制超限,绕开 early-return
    process.env.ZAI_DATA_DIR = '/tmp/aa-sizecap-test'
    // MAX_BYTES 是模块加载时求值的常量,必须先设再 import
    process.env.ZAI_AA_OUTBOX_MAX_MB = '0.0001'
    vi.resetModules()
  })

  afterEach(() => {
    if (SAVED_ZAI_DATA_DIR === undefined) delete process.env.ZAI_DATA_DIR
    else process.env.ZAI_DATA_DIR = SAVED_ZAI_DATA_DIR
    if (SAVED_MAX_MB === undefined) delete process.env.ZAI_AA_OUTBOX_MAX_MB
    else process.env.ZAI_AA_OUTBOX_MAX_MB = SAVED_MAX_MB
  })

  it('重写前重读一次,并把并发追加的行保留下来', async () => {
    await callEnforceSizeCap('0.0001')

    // 必须重读过(修复前只有一次 readFile)
    expect(readCalls, '未发生重读 —— 并发行会被整块抹掉').toBeGreaterThanOrEqual(2)
    expect(written, '未写入任何内容').not.toBeNull()

    const out = written as unknown as string
    for (const a of APPENDED) {
      expect(out, `并发追加的行被吃掉: ${a}`).toContain(a)
    }
    // 裁剪本身仍然生效:最老的那几行应当已被丢弃
    expect(out.split('\n').filter((l) => l.trim()).length, '最老的行应当已被裁掉').toBeLessThan(
      OLD_LINES.length + APPENDED.length,
    )
  })

  it('没有并发追加时,重读不会凭空多写内容', async () => {
    statSize = 1 // 不超限 → early-return
    await callEnforceSizeCap('999')
    expect(readCalls, '不超限时不该读文件').toBe(0)
    expect(written, '不超限时不该写文件').toBeNull()
  })
})
