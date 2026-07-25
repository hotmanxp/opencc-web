import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ReplHistoryService,
  __resetReplHistoryServiceForTest,
} from '../ReplHistoryService.js'

let tmpDir: string
let historyPath: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'repl-history-test-'))
  historyPath = join(tmpDir, 'repl-history.jsonl')
  __resetReplHistoryServiceForTest()
})

afterEach(async () => {
  __resetReplHistoryServiceForTest()
  await rm(tmpDir, { recursive: true, force: true })
})

function makeService(opts: { cacheTtlMs?: number; maxBytes?: number } = {}): ReplHistoryService {
  return new ReplHistoryService({
    historyPath,
    cacheTtlMs: opts.cacheTtlMs ?? 60_000,
    maxBytes: opts.maxBytes ?? 10 * 1024 * 1024,
  })
}

describe('ReplHistoryService — appendCommand', () => {
  it('appendCommand 写入一行 JSONL', async () => {
    const svc = makeService()
    await svc.appendCommand('ls -la', 'sess-1')

    const raw = await readFile(historyPath, 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.command).toBe('ls -la')
    expect(parsed.sessionId).toBe('sess-1')
    expect(typeof parsed.ts).toBe('number')
  })

  it('appendCommand 多次写入保留所有行', async () => {
    const svc = makeService()
    await svc.appendCommand('ls -la', 'sess-1')
    await svc.appendCommand('pwd', 'sess-1')
    await svc.appendCommand('echo hi', 'sess-2')

    const raw = await readFile(historyPath, 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]).command).toBe('ls -la')
    expect(JSON.parse(lines[1]).command).toBe('pwd')
    expect(JSON.parse(lines[2]).command).toBe('echo hi')
  })

  it('appendCommand 不写入空白命令', async () => {
    const svc = makeService()
    await svc.appendCommand('   ', 'sess-1')
    await svc.appendCommand('', 'sess-1')
    const exists = await readFile(historyPath, 'utf-8').catch(() => '')
    expect(exists).toBe('')
  })

  it('appendCommand blocklist 命中则跳过', async () => {
    const svc = makeService()
    await svc.appendCommand('export PASSWORD=secret123', 'sess-1')
    await svc.appendCommand('TOKEN=abc curl https://api.example.com', 'sess-1')
    await svc.appendCommand('ls', 'sess-1')

    const raw = await readFile(historyPath, 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).command).toBe('ls')
  })

  it('appendCommand blocklist 不命中命令名包含敏感词的情况', async () => {
    const svc = makeService()
    await svc.appendCommand('git credential-osxkeychain get', 'sess-1')
    await svc.appendCommand('echo "no token here"', 'sess-1')

    const raw = await readFile(historyPath, 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('appendCommand 并发调用串行写入,行不交错', async () => {
    const svc = makeService()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => svc.appendCommand(`cmd-${i}`, 'sess-1')),
    )

    const raw = await readFile(historyPath, 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(20)
    // 每行都必须 parse 成功(无半截 JSON)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    const commands = lines.map((l) => JSON.parse(l).command)
    expect(new Set(commands).size).toBe(20)
  })
})

describe('ReplHistoryService — getTopCommands', () => {
  it('文件不存在时返回空数组', async () => {
    const svc = makeService()
    const top = await svc.getTopCommands(10)
    expect(top).toEqual([])
  })

  it('getTopCommands 按频次倒序返回', async () => {
    const svc = makeService()
    await svc.appendCommand('ls', 'sess-1')
    await svc.appendCommand('ls', 'sess-1')
    await svc.appendCommand('ls', 'sess-1')
    await svc.appendCommand('pwd', 'sess-1')
    await svc.appendCommand('pwd', 'sess-1')
    await svc.appendCommand('echo hi', 'sess-2')

    const top = await svc.getTopCommands(10)
    expect(top).toEqual([
      { command: 'ls', count: 3 },
      { command: 'pwd', count: 2 },
      { command: 'echo hi', count: 1 },
    ])
  })

  it('getTopCommands limit 限制返回数量', async () => {
    const svc = makeService()
    for (let i = 0; i < 5; i++) await svc.appendCommand(`cmd-${i}`, 'sess-1')
    const top = await svc.getTopCommands(3)
    expect(top).toHaveLength(3)
  })

  it('getTopCommands prefix 过滤', async () => {
    const svc = makeService()
    await svc.appendCommand('git status', 'sess-1')
    await svc.appendCommand('git log', 'sess-1')
    await svc.appendCommand('git status', 'sess-1')
    await svc.appendCommand('ls -la', 'sess-1')
    await svc.appendCommand('pwd', 'sess-1')

    const top = await svc.getTopCommands(10, 'git ')
    expect(top).toEqual([
      { command: 'git status', count: 2 },
      { command: 'git log', count: 1 },
    ])
  })

  it('getTopCommands TTL 缓存生效,5min 内不重读', async () => {
    const svc = makeService({ cacheTtlMs: 60_000 })

    await svc.appendCommand('a', 'sess-1')
    const top1 = await svc.getTopCommands(10)
    expect(top1).toEqual([{ command: 'a', count: 1 }])

    // 手工追加到文件(绕过 service),模拟外部写入
    await writeFile(historyPath, JSON.stringify({ ts: Date.now(), command: 'b', sessionId: 'x' }) + '\n', 'utf-8')

    // TTL 内仍走缓存,看不到新行
    const top2 = await svc.getTopCommands(10)
    expect(top2).toEqual([{ command: 'a', count: 1 }])
  })

  it('getTopCommands TTL 过期后重读', async () => {
    const svc = makeService({ cacheTtlMs: 10 })

    await svc.appendCommand('a', 'sess-1')
    const top1 = await svc.getTopCommands(10)
    expect(top1).toEqual([{ command: 'a', count: 1 }])

    await writeFile(historyPath, JSON.stringify({ ts: Date.now(), command: 'b', sessionId: 'x' }) + '\n', 'utf-8')

    await new Promise((r) => setTimeout(r, 20))
    const top2 = await svc.getTopCommands(10)
    expect(top2).toEqual([{ command: 'b', count: 1 }])
  })

  it('invalidateCache 后下次 getTopCommands 重读', async () => {
    const svc = makeService()
    await svc.appendCommand('a', 'sess-1')
    await svc.getTopCommands(10)

    await svc.appendCommand('a', 'sess-1')
    svc.invalidateCache()
    const top = await svc.getTopCommands(10)
    expect(top).toEqual([{ command: 'a', count: 2 }])
  })

  it('getTopCommands 损坏的 JSONL 行被跳过', async () => {
    const svc = makeService()
    await writeFile(
      historyPath,
      [
        JSON.stringify({ ts: Date.now(), command: 'ls', sessionId: 's1' }),
        '{ this is broken json',
        JSON.stringify({ ts: Date.now(), command: 'ls', sessionId: 's2' }),
      ].join('\n') + '\n',
      'utf-8',
    )

    const top = await svc.getTopCommands(10)
    expect(top).toEqual([{ command: 'ls', count: 2 }])
  })
})

describe('ReplHistoryService — rotate', () => {
  it('appendCommand 超 maxBytes 触发 rotate,最近一次 rotate 数据进 .1', async () => {
    const svc = makeService({ maxBytes: 200 })

    await svc.appendCommand('first', 'sess-1')
    for (let i = 0; i < 6; i++) {
      await svc.appendCommand(`cmd-${i}-padding-padding-padding`, 'sess-1')
    }

    // 多次 rotate 后 .1 应有数据;我们只保留 1 个 rotate 文件(.1)
    const r1 = await readFile(`${historyPath}.1`, 'utf-8').catch(() => '')
    expect(r1.length).toBeGreaterThan(0)
    const r2 = await readFile(`${historyPath}.2`, 'utf-8').catch(() => '')
    expect(r2).toBe('')
  })

  it('rotate 把当前主文件内容挪到 .1', async () => {
    const svc = makeService({ maxBytes: 200 })

    await svc.appendCommand('a', 'sess-1')
    await svc.appendCommand('b', 'sess-1')
    await svc.appendCommand('c', 'sess-1')
    await svc.appendCommand('d', 'sess-1')
    // 第 5 次 append 入口 size 已超 maxBytes,触发 rotate
    await svc.appendCommand('e', 'sess-1')

    const r1 = await readFile(`${historyPath}.1`, 'utf-8').catch(() => '')
    // 至少含 a(rotate 时主文件的内容)
    expect(r1).toContain('"command":"a"')
  })

  it('rotate 文档化的局限性:多次 rotate 后最早数据会被覆盖', async () => {
    // 这是 plan 风险 #1 的预期行为:rotate 只保留"最近一次 rotate 的快照",
    // 跨多次 rotate 后最早的数据丢失(因为 .1 总是被新 rotate 覆盖)。
    // 接受此限制,因为 plan 优先选择简单可靠(10MB 上限 + 单 .1)。
    const svc = makeService({ maxBytes: 200 })

    await svc.appendCommand('a-old', 'sess-1')
    for (let i = 0; i < 12; i++) {
      await svc.appendCommand(`cmd-${i}-padpadpad`, 'sess-1')
    }

    const r1 = await readFile(`${historyPath}.1`, 'utf-8').catch(() => '')
    expect(r1).not.toContain('a-old')
  })

  it('rotate 后旧文件(.1)不被 getTopCommands 读取', async () => {
    const svc = makeService({ maxBytes: 200 })
    await svc.appendCommand('rarely-used', 'sess-1')
    for (let i = 0; i < 20; i++) {
      await svc.appendCommand(`cmd-${i}-padding-padding-padding`, 'sess-1')
    }
    svc.invalidateCache()

    const top = await svc.getTopCommands(10)
    expect(top.find((e) => e.command === 'rarely-used')).toBeUndefined()
  })
})

describe('ReplHistoryService — blocklist regex', () => {
  it.each([
    ['export PASSWORD=foo'],
    ['PASSWORD="hunter2" curl api'],
    ['export API_KEY=xyz'],
    ['TOKEN=bearer123'],
    ['AWS_KEY=ak'],
    ['SECRET=hello'],
  ])('拦截 %s', async (cmd) => {
    const svc = makeService()
    await svc.appendCommand(cmd, 'sess-1')
    const raw = await readFile(historyPath, 'utf-8').catch(() => '')
    expect(raw).toBe('')
  })

  it.each([
    ['ls -la'],
    ['echo PASSWORD_is_a_thing'], // 命令中包含敏感词但不是赋值
    ['grep token file.txt'],
    ['env | grep KEY'],
  ])('不拦截 %s', async (cmd) => {
    const svc = makeService()
    await svc.appendCommand(cmd, 'sess-1')
    const raw = await readFile(historyPath, 'utf-8').catch(() => '')
    // 校验 JSONL 包含该命令的 JSON 字段前缀(避免 JSON 转义引号问题)
    expect(raw).toContain(`"command":"${cmd}"`)
  })
})

describe('ReplHistoryService — singleton + reset', () => {
  it('getReplHistoryService 返回单例', async () => {
    const { getReplHistoryService } = await import('../ReplHistoryService.js')
    const a = getReplHistoryService()
    const b = getReplHistoryService()
    expect(a).toBe(b)
  })

  it('__resetReplHistoryServiceForTest 清空单例', async () => {
    const { getReplHistoryService } = await import('../ReplHistoryService.js')
    const a = getReplHistoryService()
    __resetReplHistoryServiceForTest()
    const b = getReplHistoryService()
    expect(a).not.toBe(b)
  })
})