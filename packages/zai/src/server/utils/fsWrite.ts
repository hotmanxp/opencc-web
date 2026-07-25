import { stat, writeFile } from 'node:fs/promises';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface WriteTextFileOk { ok: true; mtime: string; size: number }
export interface WriteTextFileErr { ok: false; code: 'ENOENT' | 'EACCES' | 'ENOSPC' | 'OTHER'; error: string }
export type WriteTextFileResult = WriteTextFileOk | WriteTextFileErr;

/**
 * Overwrite `absPath` with utf8 `content`. Reports back the new mtime + size
 * on success. Designed for the `/api/fs/file` PUT endpoint — keep this
 * layer thin so the route handler owns auth (resolveSafePath) and the
 * extension allow-list, not this helper.
 *
 * Error mapping:
 *   - writeFile ENOENT → { ok:false, code:'ENOENT' }  (parent dir missing)
 *   - writeFile EACCES / EPERM → { ok:false, code:'EACCES' }
 *   - writeFile ENOSPC → { ok:false, code:'ENOSPC' }
 *   - everything else → { ok:false, code:'OTHER' }
 *
 * The caller turns `code` into an HTTP status: ENOENT → 404, EACCES / ENOSPC
 * → 500, OTHER → 500. ByteLength enforcement is the route's job (so it can
 * reject pre-write, saving a write attempt on a 2MB+ payload).
 */
export async function writeTextFile(
  absPath: string,
  content: string,
): Promise<WriteTextFileResult> {
  try {
    await writeFile(absPath, content, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, code: 'ENOENT', error: '目录不存在' };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, code: 'EACCES', error: `权限不足: ${code}` };
    }
    if (code === 'ENOSPC') {
      return { ok: false, code: 'ENOSPC', error: '磁盘空间不足' };
    }
    return { ok: false, code: 'OTHER', error: `写入失败: ${(err as Error).message}` };
  }
  const info = await stat(absPath);
  return { ok: true, mtime: info.mtime.toISOString(), size: info.size };
}
