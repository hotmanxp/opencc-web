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
