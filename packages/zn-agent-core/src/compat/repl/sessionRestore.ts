// packages/zn-agent-core/src/compat/repl/sessionRestore.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P1): full session state restoration.
 * Mirrors vendor utils/sessionRestore.ts: deserializeMessages +
 * restoreWorktree + restoreFileHistory + restoreCostState +
 * restorePlan + restoreAttribution + restoreAgent.
 * Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §4.4 + §6.
 */

import { readFileSync, existsSync } from 'fs'
import { join, sep } from 'path'

type RestoreSessionOpts = {
  sessionId: string
  cwd: string
  getAppState: () => any
  setAppState: (fn: (prev: any) => any) => void
}

type RestoredSession = {
  messages: any[]
  worktreeSession: any
  fileHistory: any[]
  costState: any
  planSlug: string | null
  attribution: any
  agentDefinition: any
}

const EMPTY_RESULT: RestoredSession = {
  messages: [],
  worktreeSession: null,
  fileHistory: [],
  costState: null,
  planSlug: null,
  attribution: null,
  agentDefinition: null,
}

export async function restoreSession(opts: RestoreSessionOpts): Promise<RestoredSession> {
  // Try direct path first: ${cwd}/${sessionId}.jsonl
  const directPath = opts.cwd + sep + opts.sessionId + '.jsonl'
  if (existsSync(directPath)) {
    return readSessionFile(directPath)
  }
  // Then vendor convention paths
  const vendorPath1 = join(opts.cwd, '.zai', 'sessions', opts.sessionId + '.jsonl')
  if (existsSync(vendorPath1)) {
    return readSessionFile(vendorPath1)
  }
  const vendorPath2 = join(opts.cwd, '.zai', 'projects', opts.sessionId, 'session.jsonl')
  if (existsSync(vendorPath2)) {
    return readSessionFile(vendorPath2)
  }
  return EMPTY_RESULT
}

function readSessionFile(jsonlPath: string): RestoredSession {
  let content: string
  try {
    content = readFileSync(jsonlPath, 'utf8')
  } catch {
    return EMPTY_RESULT
  }

  const entries = content.split('\n').filter(Boolean).map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)

  const result: RestoredSession = {
    messages: [],
    worktreeSession: null,
    fileHistory: [],
    costState: null,
    planSlug: null,
    attribution: null,
    agentDefinition: null,
  }

  for (const entry of entries) {
    switch (entry.type) {
      case 'user':
      case 'assistant':
      case 'attachment':
      case 'system':
        result.messages.push(entry)
        break
      case 'worktree-snapshot':
        result.worktreeSession = entry.worktreeSession
        break
      case 'file-history-snapshot':
        result.fileHistory.push(entry)
        break
      case 'cost-state':
        result.costState = entry.costState
        break
      case 'plan':
        result.planSlug = entry.planSlug ?? null
        break
      case 'attribution-snapshot':
        result.attribution = entry.attribution
        break
      case 'agent-setting':
        result.agentDefinition = entry.agentDefinition
        break
    }
  }

  return result
}
