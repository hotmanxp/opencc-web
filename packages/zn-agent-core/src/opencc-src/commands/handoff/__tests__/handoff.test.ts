import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listHandoffs,
  getLatestHandoff,
  buildHandoffPath,
} from '../handoff.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'handon-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('listHandoffs', () => {
  test('returns empty array for non-existent directory', async () => {
    const result = await listHandoffs(join(root, 'missing'))
    expect(result).toEqual([])
  })

  test('returns empty array for empty directory', async () => {
    // mkdtemp already created root
    const result = await listHandoffs(root)
    expect(result).toEqual([])
  })

  test('returns only .md files', async () => {
    await writeFile(join(root, 'a.md'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')
    await writeFile(join(root, 'c.md'), 'c')
    const result = await listHandoffs(root)
    expect(result.sort()).toEqual(
      [join(root, 'a.md'), join(root, 'c.md')].sort(),
    )
  })

  test('sorts by mtime descending (latest first)', async () => {
    await writeFile(join(root, 'old.md'), 'old')
    await writeFile(join(root, 'mid.md'), 'mid')
    await writeFile(join(root, 'new.md'), 'new')

    const now = Date.now() / 1000
    await utimes(join(root, 'old.md'), now - 300, now - 300)
    await utimes(join(root, 'mid.md'), now - 200, now - 200)
    await utimes(join(root, 'new.md'), now - 100, now - 100)

    const result = await listHandoffs(root)
    expect(result).toEqual([
      join(root, 'new.md'),
      join(root, 'mid.md'),
      join(root, 'old.md'),
    ])
  })
})

describe('getLatestHandoff', () => {
  test('returns null for empty directory', async () => {
    // mkdtemp already created root
    const result = await getLatestHandoff(root)
    expect(result).toBeNull()
  })

  test('returns the most recently modified file', async () => {
    await writeFile(join(root, 'a.md'), 'a')
    await writeFile(join(root, 'b.md'), 'b')
    const now = Date.now() / 1000
    await utimes(join(root, 'a.md'), now - 100, now - 100)
    await utimes(join(root, 'b.md'), now - 200, now - 200)
    const result = await getLatestHandoff(root)
    expect(result).toBe(join(root, 'a.md'))
  })
})

describe('buildHandoffPath', () => {
  test('joins root + task + date with .md', () => {
    const result = buildHandoffPath('/tmp/x', 'add-foo', '2026-06-07')
    expect(result).toBe('/tmp/x/add-foo-2026-06-07.md')
  })
})
