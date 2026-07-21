import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let originalHome: string | undefined
let tmpHome: string

beforeEach(() => {
  originalHome = process.env.HOME
  tmpHome = mkdtempSync(join(tmpdir(), 'zai-cmdcrud-'))
  process.env.HOME = tmpHome
})

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('commands CRUD routes', () => {
  it('readCommandList returns [] when commands dir does not exist', async () => {
    const commandsDir = join(tmpHome, '.zai', 'commands')
    rmSync(commandsDir, { recursive: true, force: true })
    const { readCommandList } = await import('../../../src/server/services/commands/fileStore.js')
    expect(await readCommandList()).toEqual([])
  })

  it('PUT then GET reads the saved file', async () => {
    const { writeCommandFile, readCommandFile } = await import('../../../src/server/services/commands/fileStore.js')
    await writeCommandFile('greet', { description: 'Say hi', argumentHint: '[name]' }, 'Hello $1')
    const out = await readCommandFile('greet')
    expect(out).not.toBeNull()
    expect(out!.frontmatter.description).toBe('Say hi')
    expect(out!.body).toBe('Hello $1\n')
  })

  it('write rejects invalid name', async () => {
    const { writeCommandFile } = await import('../../../src/server/services/commands/fileStore.js')
    await expect(writeCommandFile('Bad-Name', { description: 'x' }, 'b')).rejects.toThrow()
  })

  it('delete removes file', async () => {
    const { writeCommandFile, deleteCommandFile, readCommandFile } = await import('../../../src/server/services/commands/fileStore.js')
    await writeCommandFile('foo', { description: 'x' }, 'b')
    await deleteCommandFile('foo')
    expect(await readCommandFile('foo')).toBeNull()
  })
})