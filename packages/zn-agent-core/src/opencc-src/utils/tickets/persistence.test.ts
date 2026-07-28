// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import path from 'node:path'
import os from 'node:os'

// 1. Override TICKET_LIST_PATH to a tmp file before importing the module under test.
const TMP_PATH = path.join(os.tmpdir(), `opencc-tickets-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)

// Use mock.module to point the paths module at our tmp file.
// (Bun's mock.module requires top-level await.)
await mock.module('./paths.js', () => ({
  TICKET_LIST_PATH: TMP_PATH,
}))

const { readTicketList, writeTicketList, pushTicketEntry } = await import('./persistence.js')

afterEach(async () => {
  try {
    const fs = await import('node:fs/promises')
    await fs.unlink(TMP_PATH)
  } catch {}
})

describe('readTicketList', () => {
  test('returns [] when file does not exist', async () => {
    const list = await readTicketList()
    expect(list).toEqual([])
  })

  test('returns parsed array when file is valid', async () => {
    const fs = await import('node:fs/promises')
    await fs.writeFile(TMP_PATH, JSON.stringify(['A', 'B']))
    const list = await readTicketList()
    expect(list).toEqual(['A', 'B'])
  })

  test('returns [] on corrupted JSON', async () => {
    const fs = await import('node:fs/promises')
    await fs.writeFile(TMP_PATH, '{not-json')
    const list = await readTicketList()
    expect(list).toEqual([])
  })

  test('returns [] when root is not an array', async () => {
    const fs = await import('node:fs/promises')
    await fs.writeFile(TMP_PATH, JSON.stringify({ ids: [] }))
    const list = await readTicketList()
    expect(list).toEqual([])
  })

  test('filters out non-string entries', async () => {
    const fs = await import('node:fs/promises')
    await fs.writeFile(TMP_PATH, JSON.stringify(['A', 42, null, 'B']))
    const list = await readTicketList()
    expect(list).toEqual(['A', 'B'])
  })
})

describe('writeTicketList', () => {
  test('writes a valid JSON array', async () => {
    await writeTicketList(['A', 'B'])
    const fs = await import('node:fs/promises')
    const raw = await fs.readFile(TMP_PATH, 'utf8')
    expect(JSON.parse(raw)).toEqual(['A', 'B'])
  })

  test('truncates to 20 entries', async () => {
    const long = Array.from({ length: 25 }, (_, i) => `id${i}`)
    await writeTicketList(long)
    const list = await readTicketList()
    expect(list).toHaveLength(20)
    expect(list[0]).toBe('id0')
    expect(list[19]).toBe('id19')
  })
})

describe('pushTicketEntry', () => {
  test('creates file with single entry on empty state', async () => {
    const next = await pushTicketEntry('A')
    expect(next).toEqual(['A'])
  })

  test('prepends new id', async () => {
    await writeTicketList(['B'])
    const next = await pushTicketEntry('A')
    expect(next).toEqual(['A', 'B'])
  })

  test('dedupes existing id and moves it to head', async () => {
    await writeTicketList(['A', 'B', 'C'])
    const next = await pushTicketEntry('B')
    expect(next).toEqual(['B', 'A', 'C'])
  })

  test('caps at 20 entries', async () => {
    const initial = Array.from({ length: 20 }, (_, i) => `id${i}`)
    await writeTicketList(initial)
    const next = await pushTicketEntry('new')
    expect(next).toHaveLength(20)
    expect(next[0]).toBe('new')
    expect(next).not.toContain('id19') // tail truncated
  })
})
