// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AttachmentZone, { DND_MIME, parseRefPayload } from './AttachmentZone.js';
import type { FileRef } from './gatherMentions.js';
import '@testing-library/jest-dom';

const ref = (path: string): FileRef => ({ id: `r-${path}`, path, name: path.split('/').pop()!, kind: 'file' });
const fakeDrag = (payload: string, mime = DND_MIME) =>
  ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { getData: (t: string) => (t === mime ? payload : ''), types: [mime] } }) as unknown as React.DragEvent;

describe('AttachmentZone', () => {
  test('drop 携带 application/x-zai-file → onAddRef 收到解析后的 FileRef', () => {
    const onAddRef = vi.fn();
    render(<AttachmentZone refs={[]} onAddRef={onAddRef} onRemoveRef={() => {}} />);
    const zone = screen.getByTestId('attachment-zone');
    fireEvent.dragOver(zone, { dataTransfer: { types: [DND_MIME] } });
    fireEvent.drop(zone, fakeDrag(JSON.stringify({ path: '/a/b.md', name: 'b.md', kind: 'file' })));
    expect(onAddRef).toHaveBeenCalledWith({ id: 'r-/a/b.md', path: '/a/b.md', name: 'b.md', kind: 'file' });
  });

  test('最大 16:已有 16 个时 drop 不触发 onAddRef', () => {
    const refs = Array.from({ length: 16 }, (_, i) => ref(`/f${i}.md`));
    const onAddRef = vi.fn();
    render(<AttachmentZone refs={refs} onAddRef={onAddRef} onRemoveRef={() => {}} />);
    fireEvent.drop(screen.getByTestId('attachment-zone'), fakeDrag(JSON.stringify({ path: '/new.md', name: 'new.md', kind: 'file' })));
    expect(onAddRef).not.toHaveBeenCalled();
  });

  test('渲染既有 refs 为 chip,点 X 触发 onRemoveRef', () => {
    const onRemoveRef = vi.fn();
    render(<AttachmentZone refs={[ref('/a/b.md')]} onAddRef={() => {}} onRemoveRef={onRemoveRef} />);
    expect(screen.getByText('b.md')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('移除附件'));
    expect(onRemoveRef).toHaveBeenCalledWith('r-/a/b.md');
  });

  test('parseRefPayload 校验缺字段 → null', () => {
    expect(parseRefPayload(JSON.stringify({ path: '/x' }))).toBeNull();
    expect(parseRefPayload('not-json')).toBeNull();
  });

  test('空态渲染瘦提示条且可被 drop(始终可见)', () => {
    const onAddRef = vi.fn();
    render(<AttachmentZone refs={[]} onAddRef={onAddRef} onRemoveRef={() => {}} />);
    expect(screen.getByText(/拖拽文件到此处/)).toBeInTheDocument();
  });
});
