import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { displayFilesTool } from '../../../src/compat/tools/displayFiles.js'

async function tmp(name: string, content: string | Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'displayfiles-'))
  const p = path.join(dir, name)
  await fs.writeFile(p, content)
  return p
}

describe('displayFilesTool', () => {
  it('returns metadata for each input path', async () => {
    const a = await tmp('a.ts', 'const x = 1\n')
    const b = await tmp('b.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const result = await displayFilesTool.call({ paths: [a, b] }, { cwd: '/tmp' } as any)
    // makeTool returns { output: string }; the executor JSON-stringifies an
    // Anthropic-style content block into output so the test (and downstream
    // consumers) can parse the structured payload.
    const payload = JSON.parse(result.output).content[0].json
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
    const result = await displayFilesTool.call({ paths: [a] }, { cwd: '/tmp' } as any)
    const payload = JSON.parse(result.output).content[0].json
    expect(payload.files[0].kind).toBe('html')
  })

  it('classifies unknown extension as binary', async () => {
    const a = await tmp('blob.zip', 'PK')
    const result = await displayFilesTool.call({ paths: [a] }, { cwd: '/tmp' } as any)
    const payload = JSON.parse(result.output).content[0].json
    expect(payload.files[0].kind).toBe('binary')
  })

  it('returns ENOENT error for missing path', async () => {
    const result = await displayFilesTool.call(
      { paths: ['/this/does/not/exist.txt'] },
      { cwd: '/tmp' } as any,
    )
    const payload = JSON.parse(result.output).content[0].json
    expect(payload.files[0].error.code).toBe('ENOENT')
    expect(payload.files[0].kind).toBe('binary')
  })

  it('returns EISDIR error for a directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'displayfiles-dir-'))
    const result = await displayFilesTool.call(
      { paths: [dir] },
      { cwd: '/tmp' } as any,
    )
    const payload = JSON.parse(result.output).content[0].json
    expect(payload.files[0].error.code).toBe('EISDIR')
  })

  it('handles mix of valid + invalid paths independently', async () => {
    const a = await tmp('a.ts', 'ok')
    const result = await displayFilesTool.call(
      { paths: [a, '/nope.txt'] },
      { cwd: '/tmp' } as any,
    )
    const payload = JSON.parse(result.output).content[0].json
    expect(payload.files[0].error).toBeUndefined()
    expect(payload.files[1].error.code).toBe('ENOENT')
  })

  it('rejects empty paths array', async () => {
    const result = await displayFilesTool.call({ paths: [] }, { cwd: '/tmp' } as any)
    expect(result.output).toContain('paths 不能为空')
  })

  it('rejects more than 20 paths', async () => {
    const result = await displayFilesTool.call(
      { paths: Array(21).fill('/tmp/x') },
      { cwd: '/tmp' } as any,
    )
    expect(result.output).toContain('单次最多 20 个文件')
  })
})
