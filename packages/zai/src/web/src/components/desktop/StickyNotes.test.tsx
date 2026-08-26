// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StickyNotes from './StickyNotes.js';
import { newStickyNote, type StickyNote } from './desktopStore.js';

const note = (over: Partial<StickyNote> = {}): StickyNote => ({ id: 'n-1', text: '记得补周报', x: 40, y: 60, color: '#ffd75e', ...over });
const V = { w: 1200, h: 800 };

describe('StickyNotes', () => {
  test('渲染便签文字;空数组时返回 null', () => {
    const { rerender } = render(<StickyNotes notes={[note()]} onChange={() => {}} onDelete={() => {}} viewport={V} />);
    expect(screen.getByText('记得补周报')).not.toBeNull();
    rerender(<StickyNotes notes={[]} onChange={() => {}} onDelete={() => {}} viewport={V} />);
    expect(screen.queryByText('记得补周报')).toBeNull();
  });
  test('编辑 textarea → onChange 收到新文本', () => {
    const onChange = vi.fn();
    render(<StickyNotes notes={[note()]} onChange={onChange} onDelete={() => {}} viewport={V} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '已改' } });
    expect(onChange).toHaveBeenCalledWith('n-1', { text: '已改' });
  });
  test('点 X → onDelete 收到 id', () => {
    const onDelete = vi.fn();
    render(<StickyNotes notes={[note()]} onChange={() => {}} onDelete={onDelete} viewport={V} />);
    fireEvent.click(screen.getByLabelText('删除便签'));
    expect(onDelete).toHaveBeenCalledWith('n-1');
  });
  test('newStickyNote 工厂级联 + id 唯一', () => {
    const a = newStickyNote(V, 0), b = newStickyNote(V, 1);
    expect(a.id).not.toBe(b.id);
    expect(a.y).not.toBe(b.y);
  });
});