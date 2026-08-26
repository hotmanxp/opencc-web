// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TodoPanel from './TodoPanel.js';
import type { TodoItem } from './desktopStore.js';

const item = (over: Partial<TodoItem> = {}): TodoItem => ({ id: 't-1', text: '写周报', done: false, ...over });

describe('TodoPanel', () => {
  test('渲染待办列表,done 项带删除线', () => {
    render(<TodoPanel todos={[item(), item({ id: 't-2', text: '评审', done: true })]} onAdd={() => {}} onToggle={() => {}} onDelete={() => {}} onClose={() => {}} />);
    expect(screen.getByText('写周报')).not.toBeNull();
    const done = screen.getByText('评审');
    expect((done.closest('span')?.style.textDecoration || '')).toContain('line-through');
  });
  test('输入 + 回车 → onAdd 收到文本, 并触发清空(二次输入不重复)', () => {
    const onAdd = vi.fn();
    render(<TodoPanel todos={[]} onAdd={onAdd} onToggle={() => {}} onDelete={() => {}} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/添加待办/);
    fireEvent.change(input, { target: { value: '整理桌面' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('整理桌面');
    expect((input as HTMLInputElement).value).toBe('');
  });
  test('勾选 → onToggle(id);点 X → onDelete(id)', () => {
    const onToggle = vi.fn(), onDelete = vi.fn();
    render(<TodoPanel todos={[item()]} onAdd={() => {}} onToggle={onToggle} onDelete={onDelete} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledWith('t-1');
    fireEvent.click(screen.getByLabelText('删除待办'));
    expect(onDelete).toHaveBeenCalledWith('t-1');
  });
  test('空列表显示「暂无待办」', () => {
    render(<TodoPanel todos={[]} onAdd={() => {}} onToggle={() => {}} onDelete={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/暂无待办/)).not.toBeNull();
  });
});