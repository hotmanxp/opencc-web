import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  displayFilesOpenccTool,
  takeDisplayFilesOutput,
} from '../../../src/opencc-src/server/displayFilesOpencc.js'

async function tmp(name: string, content: string | Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'displayfiles-opencc-'))
  const p = path.join(dir, name)
  await fs.writeFile(p, content)
  return p
}

async function parseOutput(result: unknown): Promise<{ files: Array<Record<string, unknown>> }> {
  // vendor Tool.call returns { data: { output: <json-stringified wrapper> } }
  // zai 前端 fileDisplayRenderer::parseFiles 解析 output 字符串里的
  // wrapper.content[0].json.files 拿到 FileMeta[]。
  const data = (result as { data: { output: string } }).data
  const wrapper = JSON.parse(data.output)
  return wrapper.content[0].json
}

describe('displayFilesOpenccTool', () => {
  it('returns metadata for each input path', async () => {
    const a = await tmp('a.ts', 'const x = 1\n')
    const b = await tmp('b.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const result = await displayFilesOpenccTool.call({ paths: [a, b] }, {} as any, undefined as any, undefined as any, undefined as any)
    const payload = await parseOutput(result)
    expect(payload.files).toHaveLength(2)
    expect(payload.files[0].path).toBe(a)
    expect(payload.files[0].name).toBe('a.ts')
    expect(payload.files[0].kind).toBe('text')
    // 'const x = 1\n' = c,o,n,s,t, ,x, ,=, ,1,\n = 12 bytes.
    expect(payload.files[0].size).toBe(12)
    expect(payload.files[1].kind).toBe('image')
  })

  it('classifies html files as kind html', async () => {
    const a = await tmp('page.html', '<h1>x</h1>')
    const result = await displayFilesOpenccTool.call({ paths: [a] }, {} as any, undefined as any, undefined as any, undefined as any)
    const payload = await parseOutput(result)
    expect(payload.files[0].kind).toBe('html')
  })

  it('classifies unknown extension as binary', async () => {
    const a = await tmp('blob.zip', 'PK')
    const result = await displayFilesOpenccTool.call({ paths: [a] }, {} as any, undefined as any, undefined as any, undefined as any)
    const payload = await parseOutput(result)
    expect(payload.files[0].kind).toBe('binary')
  })

  it('returns ENOENT error for missing path', async () => {
    const result = await displayFilesOpenccTool.call(
      { paths: ['/this/does/not/exist.txt'] },
      {} as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    const payload = await parseOutput(result)
    expect(payload.files[0].error.code).toBe('ENOENT')
    expect(payload.files[0].kind).toBe('binary')
  })

  it('returns EISDIR error for a directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'displayfiles-opencc-dir-'))
    const result = await displayFilesOpenccTool.call(
      { paths: [dir] },
      {} as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    const payload = await parseOutput(result)
    expect(payload.files[0].error.code).toBe('EISDIR')
  })

  it('handles mix of valid + invalid paths independently', async () => {
    const a = await tmp('a.ts', 'ok')
    const result = await displayFilesOpenccTool.call(
      { paths: [a, '/nope.txt'] },
      {} as any,
      undefined as any,
      undefined as any,
      undefined as any,
    )
    const payload = await parseOutput(result)
    expect(payload.files[0].error).toBeUndefined()
    expect(payload.files[1].error.code).toBe('ENOENT')
  })

  it('rejects empty paths array — input schema is min(1)', async () => {
    // vendor buildTool does NOT auto-validate input at the call boundary
    // (schema is consumed by the API serializer, not the executor). We
    // verify the schema itself rejects empty / oversized arrays so the
    // downstream toolToAPISchema → zodToJsonSchema wire reflects it.
    const schema = displayFilesOpenccTool.inputSchema as any
    const empty = schema.safeParse({ paths: [] })
    expect(empty.success).toBe(false)
    if (!empty.success) {
      expect(empty.error.issues[0].message).toContain('paths 不能为空')
    }
  })

  it('rejects more than 20 paths — input schema is max(20)', async () => {
    const schema = displayFilesOpenccTool.inputSchema as any
    const over = schema.safeParse({ paths: Array(21).fill('/tmp/x') })
    expect(over.success).toBe(false)
    if (!over.success) {
      expect(over.error.issues[0].message).toContain('单次最多 20 个文件')
    }
  })

  it('exposes tool name as DisplayFiles and is read-only', () => {
    expect(displayFilesOpenccTool.name).toBe('DisplayFiles')
    expect(displayFilesOpenccTool.isReadOnly()).toBe(true)
    expect(displayFilesOpenccTool.isConcurrencySafe()).toBe(true)
    expect(displayFilesOpenccTool.isDestructive()).toBe(false)
  })

  it('description matches spec (mentions 预览 + 单次最多 20)', async () => {
    const desc = await displayFilesOpenccTool.description()
    expect(desc).toContain('预览')
    expect(desc).toContain('单次最多 20')
  })

  it('mapToolResultToToolResultBlockParam returns literal "done" so the model never sees raw file metadata', () => {
    // zai patch:DisplayFiles 是给前端用的工具 —— 文件元数据由前端解析
    // 渲染,LLM 拿到只会浪费上下文。这里固定返回 'done',确认 wire shape
    // 不再把 call() 的 JSON 输出回灌到 tool_result.content。
    const block = displayFilesOpenccTool.mapToolResultToToolResultBlockParam(
      { output: '{"content":[{"type":"json","json":{"files":[]}}]}' },
      'toolu_test_001',
    )
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_test_001',
      content: 'done',
    })
    expect((block as { content: string }).content).not.toContain('files')
  })

  it('stashes the wrapper by toolUseId while still returning "done" (frontend display channel)', () => {
    // zai patch:SSE `runtime.tool_result.output` 就是 tool_result content,
    // 而 content 回灌给 LLM 是 'done'。为让前端 fileDisplayRenderer 能拿到
    // wrapper JSON 渲染卡片,mapToolResult 先把 wrapper 按 toolUseId 暂存,
    // zai server 转发时经 takeDisplayFilesOutput 取出(取出即删)。
    const toolUseId = 'toolu_stash_001'
    const wrapper = '{"content":[{"type":"json","json":{"files":[{"path":"/a.ts"}]}}]}'
    const block = displayFilesOpenccTool.mapToolResultToToolResultBlockParam(
      { output: wrapper },
      toolUseId,
    )
    expect(block).toMatchObject({ content: 'done' })
    // 同一次调用存了一份、取出一份,与前端契约(wrapper JSON 字符串)一致
    expect(takeDisplayFilesOutput(toolUseId)).toBe(wrapper)
    // 取出即删,再次读取拿不到
    expect(takeDisplayFilesOutput(toolUseId)).toBeUndefined()
  })

  it('takeDisplayFilesOutput returns undefined for unknown or non-string outputs', () => {
    expect(displayFilesOpenccTool.mapToolResultToToolResultBlockParam(
      { output: undefined },
      'toolu_noop_001',
    )).toMatchObject({ content: 'done' })
    expect(takeDisplayFilesOutput('toolu_noop_001')).toBeUndefined()
    expect(takeDisplayFilesOutput('toolu_never_called')).toBeUndefined()
  })
})