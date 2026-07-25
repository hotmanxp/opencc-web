import { useCallback, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { FsFile } from '../../../../shared/fs.js';

export interface UseFsWriteResult {
  save: (path: string, content: string) => Promise<{ ok: boolean; mtime?: string; size?: number; error?: string }>;
  saving: boolean;
}

/**
 * Wraps `PUT /api/fs/file` for the file editor. Returns `{ ok:false, error }`
 * instead of throwing — the editor stays mounted on failure so the user's
 * keystrokes aren't lost. `saving` is a single in-flight flag (the editor
 * only needs to know "is a save happening right now" for the Save button
 * loading state; concurrent saves are not a supported flow).
 */
export function useFsWrite(): UseFsWriteResult {
  const [saving, setSaving] = useState(false);
  // Ref guard so a stray double-click on Save doesn't double-fire while
  // saving is true. setSaving is async; we want the second click to bail
  // immediately.
  const inFlight = useRef(false);

  const save = useCallback(async (path: string, content: string) => {
    if (inFlight.current) {
      return { ok: false, error: '已有保存请求正在进行' };
    }
    inFlight.current = true;
    setSaving(true);
    try {
      const res = await api.put<FsFile>('/fs/file', { path, content });
      if (!res.ok) {
        return { ok: false, error: res.error ?? '保存失败' };
      }
      return { ok: true, mtime: res.mtime, size: res.size };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, []);

  return { save, saving };
}
