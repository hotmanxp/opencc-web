import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sendFileToUserTool,
  setWeixinFileSender,
  getWeixinFileSender,
  type WeixinFileSender,
} from '../../src/opencc-src/server/sendFileToUser.js'

function tmpFile(name: string, content = 'hello'): string {
  const dir = mkdtempSync(join(tmpdir(), 'zai-sendfile-'))
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

describe('SendFileToUser tool (zai patch 2026-09-13)', () => {
  afterEach(() => {
    setWeixinFileSender(null)
  })

  it('注册表:注入/读取/置空', () => {
    expect(getWeixinFileSender()).toBeNull()
    const fn: WeixinFileSender = async () => ({ success: true })
    setWeixinFileSender(fn)
    expect(getWeixinFileSender()).toBe(fn)
    setWeixinFileSender(null)
    expect(getWeixinFileSender()).toBeNull()
  })

  it('sender 未注入 → FAILED 文案(不抛异常)', async () => {
    const p = tmpFile('report.md')
    const result = (await sendFileToUserTool.call({ filePath: p })) as {
      data: { output: string }
    }
    expect(result.data.output).toMatch(/^FAILED: file sending is not available/)
  })

  it('路径不存在/是目录 → FAILED 文案', async () => {
    const result = (await sendFileToUserTool.call({
      filePath: '/nonexistent/no/such/file.bin',
    })) as { data: { output: string } }
    expect(result.data.output).toMatch(/^FAILED: cannot access file \(ENOENT\)/)

    const dir = mkdtempSync(join(tmpdir(), 'zai-sendfile-dir-'))
    const result2 = (await sendFileToUserTool.call({ filePath: dir })) as {
      data: { output: string }
    }
    expect(result2.data.output).toBe('FAILED: path is a directory, not a file')
  })

  it('成功路径:调 sender 并透传结果;kind 按扩展名推断', async () => {
    const calls: Array<{ sessionId: string; filePath: string; kind?: string }> = []
    setWeixinFileSender(async (req) => {
      calls.push(req)
      return { success: true }
    })
    const p = tmpFile('chart.png')
    const result = (await sendFileToUserTool.call({ filePath: p })) as {
      data: { output: string }
    }
    expect(result.data.output).toMatch(/^SENT: .+ \(5 bytes\)$/)
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe('image')
    expect(typeof calls[0].sessionId).toBe('string')
    expect(calls[0].sessionId.length).toBeGreaterThan(0)
  })

  it('sender 失败 → FAILED 文案透传错误', async () => {
    setWeixinFileSender(async () => ({
      success: false,
      error: 'WeChat channel is not connected',
    }))
    const p = tmpFile('data.csv')
    const result = (await sendFileToUserTool.call({ filePath: p })) as {
      data: { output: string }
    }
    expect(result.data.output).toBe('FAILED: WeChat channel is not connected')
  })

  it('未知扩展名默认按 file 类别', async () => {
    const calls: Array<{ kind?: string }> = []
    setWeixinFileSender(async (req) => {
      calls.push(req)
      return { success: true }
    })
    const p = tmpFile('archive.xyz')
    await sendFileToUserTool.call({ filePath: p })
    expect(calls[0].kind).toBe('file')
    rmSync(p)
  })
})
