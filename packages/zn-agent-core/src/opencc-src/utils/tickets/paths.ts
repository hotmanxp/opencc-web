// src/utils/tickets/paths.ts
import os from 'node:os'
import path from 'node:path'

export const TICKET_LIST_PATH: string = path.join(
  os.homedir(),
  '.zai',
  'git-flow',
  'ticket-list.json',
)
