/**
 * Handoff fs utilities — self-contained (no opencc-src dependency).
 *
 * The original compat shim re-exported from `opencc-src/commands/handoff/handoff.ts`,
 * which broke the build because `packages/zn-agent-core/tsconfig.json` excludes
 * `src/opencc-src` from the tsc project (`composite: true` project references
 * cannot follow files outside the include set — TS6307). This file defines
 * the small subset that zai needs as a verbatim port.
 *
 * zai only consumes:
 *   - `listHandoffs(root)` — returns `.md` files in `root` sorted by mtime desc
 *      (skips unreadable entries, returns [] when root is missing)
 *   - `getLatestHandoff(root)` — convenience wrapper returning `listHandoffs(root)[0] ?? null`
 *   - `buildHandoffPath(root, task, date)` — joins `root` + `<task>-<date>.md`
 *
 * If opencc's full handoff handler is later required (it depends on
 * ToolUseContext / command pipeline), zai should keep its own handler rather
 * than re-importing — these fs helpers are intentionally the only shared layer.
 *
 * If vendor `opencc-src/commands/handoff/handoff.ts` changes, sync this file
 * byte-for-byte and re-run `pnpm run build:core` + the unit tests.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export async function listHandoffs(root: string): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch {
    return []
  }
  const entries = await Promise.all(
    names
      .filter(n => n.endsWith('.md'))
      .map(async n => {
        const full = path.join(root, n)
        try {
          const st = await fs.stat(full)
          return { full, mtime: st.mtimeMs }
        } catch {
          return null
        }
      }),
  )
  return entries
    .filter((e): e is { full: string; mtime: number } => e !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map(e => e.full)
}

export async function getLatestHandoff(root: string): Promise<string | null> {
  const all = await listHandoffs(root)
  return all[0] ?? null
}

export function buildHandoffPath(
  root: string,
  task: string,
  date: string,
): string {
  return path.join(root, `${task}-${date}.md`)
}
