/**
 * Cross-tool read state used by FileReadTool/FileWriteTool to enforce
 * upstream OpenCC's Read-first write contract: Write may only overwrite a
 * file if Read observed it most recently. Mirrors `readFileState` in
 * `opencc-worktree/src/Tool.ts`; we collapse "isPartialView" tracking for now
 * since zai's Read tool returns full file content (no offset/limit on the
 * contract layer beyond what schema exposes).
 *
 * Keyed on `cwd + ':' + absPath` so concurrent sessions with different cwds
 * don't collide. Value is the mtime in milliseconds observed at read time,
 * or `0` as a sentinel meaning "Read confirmed this path did not exist at
 * that moment" (so a later Write that creates the file is also gated).
 */
const READ_MTIMES = new Map<string, number>()

function key(cwd: string, absPath: string): string {
  return `${cwd}:${absPath}`
}

export function markRead(cwd: string, absPath: string, mtimeMs: number): void {
  READ_MTIMES.set(key(cwd, absPath), Math.floor(mtimeMs))
}

export function markAbsent(cwd: string, absPath: string): void {
  // sentinel: Read confirmed the path did not exist; further Write must not
  // overwrite without another Read
  READ_MTIMES.set(key(cwd, absPath), 0)
}

export function lastRead(cwd: string, absPath: string): number | undefined {
  return READ_MTIMES.get(key(cwd, absPath))
}

export function clearReadState(): void {
  READ_MTIMES.clear()
}
