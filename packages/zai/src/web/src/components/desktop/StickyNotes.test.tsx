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
  test('resize handle 存在,pointerDown 后 pointerMove 触发 onChange({w,h})', () => {
    const onChange = vi.fn();
    render(<StickyNotes notes={[note({ x: 100, y: 100 })]} onChange={onChange} onDelete={() => {}} viewport={V} />);
    const handle = screen.getByLabelText('调整便签大小');
    expect(handle).not.toBeNull();
    // pointerDown:base = {x:100, y:100, w:160, h:120}
    fireEvent.pointerDown(handle, { clientX: 260, clientY: 220, pointerId: 1 });
    // 模拟 pointerMove 到 (320, 260) → dx=60, dy=40 → w=220, h=160
    fireEvent.pointerMove(handle, { clientX: 320, clientY: 260 });
    expect(onChange).toHaveBeenCalledWith('n-1', { w: 220, h: 160 });
  });
  test('resize 有最小尺寸保护(不能拖到比 MIN_W/MIN_H 还小)', () => {
    const onChange = vi.fn();
    render(<StickyNotes notes={[note({ x: 0, y: 0 })]} onChange={onChange} onDelete={() => {}} viewport={V} />);
    const handle = screen.getByLabelText('调整便签大小');
    fireEvent.pointerDown(handle, { clientX: 160, clientY: 120, pointerId: 1 });
    // 反向拖到 (-100, -100) → dx=-260, dy=-220 → base.w=160+(-260)=-100 → clamp 到 MIN_W=100
    fireEvent.pointerMove(handle, { clientX: -100, clientY: -100 });
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(lastCall?.[1]).toEqual({ w: 100, h: 60 });
  });
  test('点击标题/textarea/resize handle 都触发 onFocus(id)', () => {
    const onFocus = vi.fn();
    render(<StickyNotes notes={[note()]} onChange={() => {}} onDelete={() => {}} onFocus={onFocus} viewport={V} />);
    // 标题栏 — 即便签 div 第一个子元素(header)
    const header = document.querySelector('[role="note"]')!.firstElementChild as HTMLElement;
    fireEvent.pointerDown(header, { pointerId: 1 });
    expect(onFocus).toHaveBeenLastCalledWith('n-1');
    // textarea
    fireEvent.pointerDown(screen.getByRole('textbox'), { pointerId: 2 });
    expect(onFocus).toHaveBeenLastCalledWith('n-1');
    // resize handle
    fireEvent.pointerDown(screen.getByLabelText('调整便签大小'), { pointerId: 3 });
    expect(onFocus).toHaveBeenLastCalledWith('n-1');
    expect(onFocus).toHaveBeenCalledTimes(3);
  });
  test('便签根据 n.z 渲染 zIndex(默认 0)', () => {
    const { rerender } = render(
      <StickyNotes notes={[note({ z: 0 })]} onChange={() => {}} onDelete={() => {}} viewport={V} />,
    );
    expect((document.querySelector('[role="note"]') as HTMLElement).style.zIndex).toBe('0');
    rerender(
      <StickyNotes notes={[note({ z: 7 })]} onChange={() => {}} onDelete={() => {}} viewport={V} />,
    );
    expect((document.querySelector('[role="note"]') as HTMLElement).style.zIndex).toBe('7');
    // z 缺省 → 0
    rerender(<StickyNotes notes={[note()]} onChange={() => {}} onDelete={() => {}} viewport={V} />);
    expect((document.querySelector('[role="note"]') as HTMLElement).style.zIndex).toBe('0');
  });
  test('newStickyNote 工厂级联 + id 唯一', () => {
    const a = newStickyNote(V, 0), b = newStickyNote(V, 1);
    expect(a.id).not.toBe(b.id);
    expect(a.y).not.toBe(b.y);
  });
});