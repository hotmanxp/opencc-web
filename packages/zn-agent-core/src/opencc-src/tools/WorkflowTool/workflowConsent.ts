// src/tools/WorkflowTool/workflowConsent.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.ts'

/**
 * Per-workflow "yes-always" consent store.
 *
 * The user can answer `yes-always` on the workflow permission dialog;
 * we then remember that choice in `<claudeConfigHomeDir>/workflow-consents.json`
 * so future invocations of the same workflow skip the dialog and return
 * `{ behavior: 'allow' }` directly.
 *
 * The file shape is a flat `{ [workflowName]: true | false }` map —
 * `true` = user previously answered yes-always, `false` = user previously
 * answered no (so the next run still goes through the dialog but the
 * dialog can default to "no" if it wants; we keep the entry as a soft
 * signal rather than hard-blocking). Reading the file tolerates a
 * missing/corrupt JSON: missing → empty map, JSON.parse throws → empty
 * map. This keeps the runtime code free of try/catch ladders at every
 * call site.
 */

type ConsentMap = Record<string, boolean>

function consentFilePath(): string {
  return join(getClaudeConfigHomeDir(), 'workflow-consents.json')
}

/**
 * Return true when the user previously answered `yes-always` for
 * `workflowName`. Always resolves to a boolean — never throws, even
 * when the consent file is missing or malformed.
 */
export async function getWorkflowConsent(workflowName: string): Promise<boolean> {
  try {
    const raw = readFileSync(consentFilePath(), 'utf-8')
    const map = JSON.parse(raw) as ConsentMap
    return map[workflowName] === true
  } catch {
    return false
  }
}

/**
 * Persist a per-workflow consent decision.
 *
 * - `allow = true` records "yes-always" so future calls short-circuit.
 * - `allow = false` records "no" so we know the user previously
 *   declined — the dialog still fires, but the data is on disk for
 *   the UI to read if it wants to default to deny.
 *
 * The directory is created lazily (some users may not have a
 * ~/.claude dir yet on first run). The file is written atomically
 * enough for this use case: a single small JSON blob, no concurrent
 * writers expected (only the current process decides on its own
 * dialog answer).
 */
export async function setWorkflowConsent(
  workflowName: string,
  allow: boolean,
): Promise<void> {
  const dir = getClaudeConfigHomeDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  let map: ConsentMap = {}
  try {
    map = JSON.parse(readFileSync(consentFilePath(), 'utf-8'))
  } catch {
    // missing or malformed — start fresh
  }
  map[workflowName] = allow
  writeFileSync(consentFilePath(), JSON.stringify(map, null, 2))
}