// src/utils/tickets/persistence.ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { TICKET_LIST_PATH } from './paths.ts'
import { logForDebugging } from '../debug.ts'

const MAX_ENTRIES = 20

export async function readTicketList(): Promise<string[]> {
  let raw: string
  try {
    raw = await fs.readFile(TICKET_LIST_PATH, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      logForDebugging(`set-ticket: readTicketList failed: ${(err as Error)?.message ?? String(err)}`, { level: 'warn' })
    }
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      logForDebugging('set-ticket: ticket-list.json is not an array', { level: 'warn' })
      return []
    }
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch (err) {
    logForDebugging(`set-ticket: ticket-list.json is malformed: ${(err as Error)?.message ?? String(err)}`, { level: 'warn' })
    return []
  }
}

export async function writeTicketList(list: string[]): Promise<void> {
  const trimmed = list.slice(0, MAX_ENTRIES)
  await fs.mkdir(path.dirname(TICKET_LIST_PATH), { recursive: true })
  await fs.writeFile(TICKET_LIST_PATH, JSON.stringify(trimmed), 'utf8')
}

export async function pushTicketEntry(id: string): Promise<string[]> {
  const list = await readTicketList()
  const deduped = list.filter(x => x !== id)
  const next = [id, ...deduped].slice(0, MAX_ENTRIES)
  await writeTicketList(next)
  return next
}
