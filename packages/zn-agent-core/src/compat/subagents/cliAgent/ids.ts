/**
 * Identity helpers for CLI-agent spawns (compat layer).
 *
 * These mirror the vendor opencc `utils/agentId.ts` + `Task.ts` semantics
 * WITHOUT importing opencc-src (tsconfig exclude). `spawnCliAgent` uses them
 * so a spawned CLI agent gets the same addressable-shape as a vendor
 * teammate (`agentName@teamName`) plus a task id in the same alphabet.
 */

import { randomInt } from 'node:crypto'

/** Strip `@` from an agent name (vendor `sanitizeAgentName`, teamHelpers.ts:108). */
export function sanitizeAgentName(name: string): string {
  return name.replace(/@/g, '-')
}

/** Format `${agentName}@${teamName}` (vendor formatAgentId, agentId.ts:38). */
export function formatAgentId(agentName: string, teamName: string): string {
  return `${agentName}@${teamName}`
}

/** Split an `agentName@teamName` id; null when no `@` separator (agentId.ts:46). */
export function parseAgentId(
  agentId: string,
): { agentName: string; teamName: string } | null {
  const atIndex = agentId.indexOf('@')
  if (atIndex === -1) return null
  return {
    agentName: agentId.slice(0, atIndex),
    teamName: agentId.slice(atIndex + 1),
  }
}

/** Vendor task-id prefixes (Task.ts:80-88); zai CLI agents are in-process teammates. */
const TASK_ID_PREFIXES: Record<string, string> = {
  in_process_teammate: 't',
}
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Gen a vendor-shaped task id: prefix + 8 chars from the 36-char alphabet (Task.ts:99). */
export function generateTaskId(type: 'in_process_teammate'): string {
  const prefix = TASK_ID_PREFIXES[type] ?? 'x'
  let id = prefix
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[randomInt(TASK_ID_ALPHABET.length)]!
  }
  return id
}

/** Keep the existing `<name>-<rand8>` shape used by providers' internal run ids. */
export function defaultCliRunId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}