import { useCallback, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { FsFile } from '../../../../shared/fs.js';

export type SaveResult =
  | { ok: true; mtime?: string; size?: number; sha256?: string }
  | { ok: false; code?: 'CONFLICT' | 'ENOENT' | 'EACCES' | 'ENOSPC' | 'OTHER'; error: string; diskSha256?: string };

export interface UseFsWriteResult {
  /** Save `content` to `path`, optionally asserting that the on-disk sha256 still equals `ifMatch`.
   *
   * - `ifMatch` 不传 → 向后兼容,服务端按无条件覆盖处理(老 client 无感)。
   * - `ifMatch` 命中 → 服务端写盘并返回新 sha256。
   * - `ifMatch` 不匹配 → 服务端 200 + `{ ok:false, code:'CONFLICT', diskSha256 }`,
   *   client 拿到的是 `{ ok:false, code:'CONFLICT', diskSha256, error }`,UI 据此
   *   显示「文件已被修改」徽章并允许重新加载。
   */
  save: (path: string, content: string, ifMatch?: string | null) => Promise<SaveResult>;
  saving: boolean;
}

/**
 * Wraps `PUT /api/fs/file` for the file editor. Returns `{ ok:false, error }`
 * instead of throwing — the editor stays mounted on failure so the user's
 * keystrokes aren't lost. `saving` is a single in-flight flag (the editor
 * only needs to know "is a save happening right now" for the Save button
 * loading state; concurrent saves are not a supported flow).
 *
 * 2026-09-27:与 AA `connectorFsWrite` 同步,加 ifMatch 支持;服务端返回
 * sha256 用于下一轮 ifMatch(对齐 AA 的乐观并发模式)。
 */
export function useFsWrite(): UseFsWriteResult {
  const [saving, setSaving] = useState(false);
  // Ref guard so a stray double-click on Save doesn't double-fire while
  // saving is true. setSaving is async; we want the second click to bail
  // immediately.
  const inFlight = useRef(false);

  const save = useCallback(async (path: string, content: string, ifMatch?: string | null): Promise<SaveResult> => {
    if (inFlight.current) {
      return { ok: false, code: 'OTHER', error: '已有保存请求正在进行' };
    }
    inFlight.current = true;
    setSaving(true);
    try {
      const body: { path: string; content: string; ifMatch?: string } = { path, content };
      if (typeof ifMatch === 'string' && ifMatch.length > 0) body.ifMatch = ifMatch;
      const res = await api.put<FsFile>('/fs/file', body);
      if (!res.ok) {
        return {
          ok: false,
          code: res.code ?? 'OTHER',
          error: res.error ?? '保存失败',
          diskSha256: res.diskSha256,
        };
      }
      return { ok: true, mtime: res.mtime, size: res.size, sha256: res.sha256 };
    } catch (err) {
      // 非 200 状态(404/413/500)走这里 — apiBase 抛 ApiError。
      // 不带 code/diskSha256,只能给通用错误文案。
      return { ok: false, code: 'OTHER', error: err instanceof Error ? err.message : String(err) };
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, []);

  return { save, saving };
}