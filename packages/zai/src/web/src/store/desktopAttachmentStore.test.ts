// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from 'vitest';
import { useDesktopAttachmentStore } from './desktopAttachmentStore.js';
import type { FileRef } from '../components/desktop/gatherMentions.js';

const ref = (path: string, kind: 'file' | 'dir' = 'file'): FileRef => ({
  id: `r-${path}`,
  path,
  name: path.split('/').pop() ?? path,
  kind,
});

beforeEach(() => {
  useDesktopAttachmentStore.setState({ refs: [], mergedIds: [] });
});

describe('desktopAttachmentStore', () => {
  test('初始为空,addRef 追加,重复拖入同一文件幂等', () => {
    const s = useDesktopAttachmentStore.getState();
    s.addRef(ref('/a/b.md'));
    s.addRef(ref('/a/b.md'));
    s.addRef(ref('/c.txt'));
    const { refs } = useDesktopAttachmentStore.getState();
    expect(refs.map((r) => r.path)).toEqual(['/a/b.md', '/c.txt']);
  });

  test('takeUnmergedMentions 首调返回 @path 并标记 merged,次调返回空', () => {
    const s = useDesktopAttachmentStore.getState();
    s.addRef(ref('/a/b.md'));
    expect(useDesktopAttachmentStore.getState().takeUnmergedMentions('')).toBe('@/a/b.md');
    expect(useDesktopAttachmentStore.getState().mergedIds).toEqual(['r-/a/b.md']);
    // 附件区保留(refs 不清空),但同一附件不再自动附带
    expect(useDesktopAttachmentStore.getState().refs).toHaveLength(1);
    expect(useDesktopAttachmentStore.getState().takeUnmergedMentions('')).toBe('');
  });

  test('draft 已含同 @path → 本次不追加(gatherMentions 去重),但仍标记 merged 防下次重复试', () => {
    const s = useDesktopAttachmentStore.getState();
    s.addRef(ref('/a/b.md'));
    expect(useDesktopAttachmentStore.getState().takeUnmergedMentions('看下 @/a/b.md')).toBe('');
    expect(useDesktopAttachmentStore.getState().mergedIds).toEqual(['r-/a/b.md']);
  });

  test('目录附带 trailing 斜杠', () => {
    const s = useDesktopAttachmentStore.getState();
    s.addRef(ref('/src', 'dir'));
    expect(useDesktopAttachmentStore.getState().takeUnmergedMentions('')).toBe('@/src/');
  });

  test('removeRef 解除 merged → 再次拖入可重新并入一次', () => {
    const s = useDesktopAttachmentStore.getState();
    s.addRef(ref('/a/b.md'));
    s.takeUnmergedMentions('');
    s.removeRef('r-/a/b.md');
    expect(useDesktopAttachmentStore.getState().mergedIds).toEqual([]);
    s.addRef(ref('/a/b.md'));
    expect(useDesktopAttachmentStore.getState().takeUnmergedMentions('')).toBe('@/a/b.md');
  });

  test('markAllMerged 后 takeUnmergedMentions 返回空(手动「并入输入框」后不再自动附带)', () => {
    const s = useDesktopAttachmentStore.getState();
    s.addRef(ref('/a/b.md'));
    s.addRef(ref('/c.txt'));
    s.markAllMerged();
    expect(useDesktopAttachmentStore.getState().takeUnmergedMentions('')).toBe('');
  });

  test('控制字符路径被 formatFileMention 拒绝 → 返回空,但仍标记 merged', () => {
    const s = useDesktopAttachmentStore.getState();
    s.addRef(ref('/a/b".md'));
    expect(useDesktopAttachmentStore.getState().takeUnmergedMentions('')).toBe('');
    expect(useDesktopAttachmentStore.getState().mergedIds).toEqual(['r-/a/b".md']);
  });
});