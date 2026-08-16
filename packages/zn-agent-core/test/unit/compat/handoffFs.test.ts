import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  listHandoffs,
  getLatestHandoff,
  buildHandoffPath,
} from '../../../src/compat/commands/handoffFs.js'

describe('handoffFs re-exports', () => {
  it('re-exports listHandoffs as a function', () => {
    expect(typeof listHandoffs).toBe('function')
  })
  it('re-exports getLatestHandoff as a function', () => {
    expect(typeof getLatestHandoff).toBe('function')
  })
  it('re-exports buildHandoffPath as a function', () => {
    expect(typeof buildHandoffPath).toBe('function')
  })

  describe('listHandoffs integration', () => {
    it('returns [] for non-existent directory', async () => {
      const result = await listHandoffs(path.join(os.tmpdir(), 'no-such-dir-xxx'))
      expect(result).toEqual([])
    })

    it('returns .md files sorted by mtime desc, filters non-.md', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-test-'))
      try {
        const old = path.join(dir, 'old.md')
        const recent = path.join(dir, 'recent.md')
        const notMd = path.join(dir, 'notes.txt')
        await fs.writeFile(old, 'old')
        await new Promise((r) => setTimeout(r, 50))
        await fs.writeFile(notMd, 'ignored')
        await new Promise((r) => setTimeout(r, 50))
        await fs.writeFile(recent, 'recent')

        const result = await listHandoffs(dir)
        expect(result).toEqual([recent, old])
        // notes.txt 被过滤
        expect(result.every((f) => f.endsWith('.md'))).toBe(true)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  })

  describe('buildHandoffPath', () => {
    it('joins root + task-date.md', () => {
      expect(buildHandoffPath('/tmp/h', 'refactor-auth', '2026-08-16')).toBe(
        path.join('/tmp/h', 'refactor-auth-2026-08-16.md'),
      )
    })
  })

  describe('getLatestHandoff', () => {
    it('returns null when no handoff files', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-empty-'))
      try {
        expect(await getLatestHandoff(dir)).toBeNull()
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })

    it('returns most recently modified .md file', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-latest-'))
      try {
        const a = path.join(dir, 'a.md')
        const b = path.join(dir, 'b.md')
        await fs.writeFile(a, 'a')
        await new Promise((r) => setTimeout(r, 50))
        await fs.writeFile(b, 'b')
        expect(await getLatestHandoff(dir)).toBe(b)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  })
})