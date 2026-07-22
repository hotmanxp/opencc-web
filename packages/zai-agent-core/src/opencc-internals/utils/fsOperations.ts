// @ts-nocheck — zai-local stub for upstream opencc's utils/fsOperations.ts.
// Upstream is excluded from the opencc-internals cherry-pick mirror (see
// packages/zai-agent-core/scripts/sync-from-opencc.ts). Minimal exports
// needed by debug.ts → openaiClient.ts → shim runtime load chain. If a
// future task needs richer behaviour, extend THIS file rather than
// pulling upstream. Listed in HARD_EXCLUDE_FILES.
//
// Returns the sync node:fs module because debug.ts calls
// getFsImplementation().mkdirSync / .appendFileSync (sync APIs needed for
// immediate-mode debug writes to survive process.exit — see debug.ts:171-176).

import * as fsSync from 'node:fs'

export function getFsImplementation(): typeof fsSync {
  return fsSync
}
