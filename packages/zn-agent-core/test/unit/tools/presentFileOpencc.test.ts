import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  presentFileOpenccTool,
  takePresentFileOutput,
} from '../../../src/opencc-src/server/presentFileOpencc.js'

async function tmp(name: string, content: string | Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'presentfile-opencc-'))
  const p = path.join(dir, name)
  await fs.writeFile(p, content)
  return p
}

async function parseOutput(result: unknown): Promise<{ file: Record<string, any>; caption?: string }> {
  // vendor Tool.call returns { data: { output: <json-stringified wrapper> } }
  // 前端 presentFileRenderer::parsePresented 解析 wrapper.content[0].json。
  const data = (result as { data: { output: string } }).data
  const wrapper = JSON.parse(data.output)
  return wrapper.content[0].json
}

async function callTool(input: { path: string; caption?: string }) {
  // vendor Tool.call 的签名带若干可选上下文参数,单测统一补 undefined。
  return presentFileOpenccTool.call(
    input,
    {} as any,
    undefined as any,
    undefined as any,
    undefined as any,
  )
}

describe('presentFileOpenccTool', () => {
  it('returns metadata for the single input path', async () => {
    const a = await tmp('a.ts', 'const x = 1\n')
    const result = await callTool({ path: a })
    const payload = await parseOutput(result)
    expect(payload.file.path).toBe(a)
    expect(payload.file.name).toBe('a.ts')
    expect(payload.file.kind).toBe('text')
    // 'const x = 1\n' = 12 bytes.
    expect(payload.file.size).toBe(12)
    expect(payload.file.error).toBeUndefined()
  })

  it('passes caption through the wrapper', async () => {
    const a = await tmp('a.ts', 'ok')
    const result = await callTool({ path: a, caption: '刚生成的架构图' })
    const payload = await parseOutput(result)
    expect(payload.caption).toBe('刚生成的架构图')
  })

  it('omits caption when not provided', async () => {
    const a = await tmp('a.ts', 'ok')
    const payload = await parseOutput(await callTool({ path: a }))
    expect(payload.caption).toBeUndefined()
  })

  it.each([
    ['page.html', 'html'],
    ['pixel.png', 'image'],
    ['shot.svg', 'image'],
    ['blob.zip', 'binary'],
    // 文档类对齐 shared/fileKind.ts —— PDF 不再被误判成 binary(本次核心修复)
    ['report.pdf', 'pdf'],
    ['doc.docx', 'docx'],
    ['book.xlsx', 'sheet'],
    ['deck.pptx', 'ppt'],
    ['legacy.doc', 'legacy-office'],
  ])('classifies %s as kind %s', async (name, kind) => {
    const p = await tmp(name, 'x')
    const payload = await parseOutput(await callTool({ path: p }))
    expect(payload.file.kind).toBe(kind)
  })

  it('returns ENOENT error for a missing path', async () => {
    const payload = await parseOutput(await callTool({ path: '/this/does/not/exist.txt' }))
    expect(payload.file.error.code).toBe('ENOENT')
    expect(payload.file.kind).toBe('binary')
  })

  it('returns EISDIR error for a directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'presentfile-opencc-dir-'))
    const payload = await parseOutput(await callTool({ path: dir }))
    expect(payload.file.error.code).toBe('EISDIR')
  })

  it('rejects an empty path — input schema is min(1)', () => {
    const schema = presentFileOpenccTool.inputSchema as any
    expect(schema.safeParse({ path: '' }).success).toBe(false)
  })

  it('rejects a caption longer than 200 chars', () => {
    const schema = presentFileOpenccTool.inputSchema as any
    expect(schema.safeParse({ path: '/a.ts', caption: 'x'.repeat(201) }).success).toBe(false)
    expect(schema.safeParse({ path: '/a.ts', caption: 'x'.repeat(200) }).success).toBe(true)
  })

  it('exposes tool name PresentFile and is read-only', () => {
    expect(presentFileOpenccTool.name).toBe('PresentFile')
    expect(presentFileOpenccTool.isReadOnly()).toBe(true)
    expect(presentFileOpenccTool.isConcurrencySafe()).toBe(true)
    expect(presentFileOpenccTool.isDestructive()).toBe(false)
  })

  it('describes itself in English (AGENTS.md: prompts must be English)', async () => {
    const desc = await presentFileOpenccTool.description()
    expect(desc).toContain('Present one local file')
    expect(desc).not.toMatch(/[\u4e00-\u9fa5]/)
  })

  it('mapToolResultToToolResultBlockParam returns literal "done" so the model never sees file metadata', () => {
    const block = presentFileOpenccTool.mapToolResultToToolResultBlockParam(
      { output: '{"content":[{"type":"json","json":{"file":{"path":"/a.ts"}}}]}' },
      'toolu_test_001',
    )
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_test_001',
      content: 'done',
    })
    expect((block as { content: string }).content).not.toContain('path')
  })

  it('stashes the wrapper by toolUseId while still returning "done" (frontend display channel)', () => {
    const toolUseId = 'toolu_stash_001'
    const wrapper = '{"content":[{"type":"json","json":{"file":{"path":"/a.ts"}}}]}'
    presentFileOpenccTool.mapToolResultToToolResultBlockParam({ output: wrapper }, toolUseId)
    expect(takePresentFileOutput(toolUseId)).toBe(wrapper)
    // 取出即删
    expect(takePresentFileOutput(toolUseId)).toBeUndefined()
  })

  it('takePresentFileOutput returns undefined for unknown ids or non-string outputs', () => {
    presentFileOpenccTool.mapToolResultToToolResultBlockParam({ output: undefined }, 'toolu_noop_001')
    expect(takePresentFileOutput('toolu_noop_001')).toBeUndefined()
    expect(takePresentFileOutput('toolu_never_called')).toBeUndefined()
  })
})