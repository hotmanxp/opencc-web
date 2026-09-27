import { stat, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface WriteTextFileOk { ok: true; mtime: string; size: number; sha256: string }
export interface WriteTextFileConflict { ok: false; code: 'CONFLICT'; error: string; diskSha256: string }
export interface WriteTextFileErr { ok: false; code: 'ENOENT' | 'EACCES' | 'ENOSPC' | 'OTHER'; error: string }
export type WriteTextFileResult = WriteTextFileOk | WriteTextFileConflict | WriteTextFileErr;

/**
 * Compute the SHA-256 hex digest of a UTF-8 string. Same input bytes
 * (regardless of how Node encodes the JS string) always produce the
 * same digest — verified in `fsWrite.test.ts`.
 */
export function sha256OfString(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

export interface WriteTextFileOptions {
  /**
   * 客户端期望的 diskSha256。若提供,与磁盘当前 sha256 不匹配时返回
   * `{ ok:false, code:'CONFLICT' }` 而非写入 —— 用于 FsTab 的乐观并发写。
   * 不传则跳过校验,无条件覆盖。
   */
  ifMatch?: string | null;
}

/**
 * Overwrite `absPath` with utf8 `content`. Reports back the new mtime + size
 * + sha256 on success. Designed for the `/api/fs/file` PUT endpoint — keep this
 * layer thin so the route handler owns auth (resolveSafePath) and the
 * extension allow-list, not this helper.
 *
 * Optimistic concurrency (2026-09-27,与 AA `connectorFsWrite` 同步):
 *   - ifMatch 提供时,先 readFile 算 diskSha256 与之比较;
 *     不匹配 → CONFLICT(带 diskSha256 让客户端拉新内容)。
 *   - ifMatch 未提供 → 无条件覆盖(向后兼容老 client)。
 *   - 注:readFile → writeFile 之间存在 TOCTOU(zai 单机单用户,风险低;
 *     强化方案 follow-up,见 plan §风险点)。
 *
 * Error mapping:
 *   - readFile ENOENT → { ok:false, code:'ENOENT' }  (parent dir missing)
 *   - writeFile ENOENT → { ok:false, code:'ENOENT' }
 *   - writeFile EACCES / EPERM → { ok:false, code:'EACCES' }
 *   - writeFile ENOSPC → { ok:false, code:'ENOSPC' }
 *   - everything else → { ok:false, code:'OTHER' }
 *
 * The caller turns `code` into an HTTP status: ENOENT → 404, EACCES / ENOSPC
 * → 500, OTHER → 500, CONFLICT → 412. ByteLength enforcement is the route's
 * job (so it can reject pre-write, saving a write attempt on a 2MB+ payload).
 */
export async function writeTextFile(
  absPath: string,
  content: string,
  options: WriteTextFileOptions = {},
): Promise<WriteTextFileResult> {
  // ifMatch 校验:仅在客户端提供时检查。
  if (options.ifMatch) {
    let diskContent: string;
    try {
      diskContent = await readFile(absPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { ok: false, code: 'ENOENT', error: '文件不存在' };
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return { ok: false, code: 'EACCES', error: `权限不足: ${code}` };
      }
      return { ok: false, code: 'OTHER', error: `读取失败: ${(err as Error).message}` };
    }
    const diskSha256 = sha256OfString(diskContent);
    if (diskSha256 !== options.ifMatch) {
      return {
        ok: false,
        code: 'CONFLICT',
        error: '文件已被修改,请重新加载',
        diskSha256,
      };
    }
  }

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
  return {
    ok: true,
    mtime: info.mtime.toISOString(),
    size: info.size,
    sha256: sha256OfString(content),
  };
}