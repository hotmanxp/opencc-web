// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Return [] (empty extension array) so langLoader returns a no-op — the editor
// still mounts and keymaps work.  An empty array is a valid CM extension.
vi.mock('@codemirror/lang-javascript', () => ({ javascript: () => [] }));
vi.mock('@codemirror/lang-json', () => ({ json: () => [] }));
vi.mock('@codemirror/lang-python', () => ({ python: () => [] }));
vi.mock('@codemirror/lang-rust', () => ({ rust: () => [] }));
vi.mock('@codemirror/lang-go', () => ({ go: () => [] }));
vi.mock('@codemirror/lang-sql', () => ({ sql: () => [] }));

import { TextEditor } from './TextEditor.js';

describe('TextEditor', () => {
  beforeEach(() => { /* nothing */ });
  afterEach(() => { cleanup(); });

  test('mounts CodeMirror with the initial content', () => {
    render(<TextEditor initialContent="hello" language="typescript" onSave={() => {}} onCancel={() => {}} />);
    const editor = screen.getByTestId('fs-editor');
    expect(editor.querySelector('.cm-editor')).toBeTruthy();
    // The doc is rendered inside .cm-content
    expect(editor.textContent).toContain('hello');
  });

  test('fires onSave with current doc on Ctrl/Cmd-S', async () => {
    const onSave = vi.fn();
    render(<TextEditor initialContent="abc" language="typescript" onSave={onSave} onCancel={() => {}} />);
    // CodeMirror receives keystrokes at the contenteditable surface; the
    // test framework dispatches a real keydown which CodeMirror's keymap
    // picks up.
    const surface = screen.getByTestId('fs-editor').querySelector('.cm-content') as HTMLElement;
    expect(surface).toBeTruthy();
    fireEvent.keyDown(surface, { key: 's', code: 'KeyS', ctrlKey: true, metaKey: false });
    // Default browser behavior would call preventDefault; we just assert
    // onSave fires with the initial doc.
    expect(onSave).toHaveBeenCalledWith('abc');
  });

  test('fires onCancel on Escape', () => {
    const onCancel = vi.fn();
    render(<TextEditor initialContent="abc" language={null} onSave={() => {}} onCancel={onCancel} />);
    const surface = screen.getByTestId('fs-editor').querySelector('.cm-content') as HTMLElement;
    fireEvent.keyDown(surface, { key: 'Escape', code: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('does not throw on unmount', () => {
    const { unmount } = render(<TextEditor initialContent="x" language={null} onSave={() => {}} onCancel={() => {}} />);
    expect(() => unmount()).not.toThrow();
  });

  test('themes .cm-cursor border in a light color on dark background', () => {
    // Regression: CM 6 默认走 light base theme → `.cm-cursor` 的 borderLeftColor
    // 是 black,在 #0d0d0d 暗背景上几乎不可见。点击编辑器后看不见光标就是这个
    // 原因。修复要求 theme 注入 `.cm-cursor, .cm-dropCursor` 的边框色覆盖。
    // CM 通过 <style> 标签注入主题,document.querySelector 拿到首条 style 后
    // 检查文本是否同时出现 `.cm-cursor` 和浅色边框。
    render(<TextEditor initialContent="hello" language={null} onSave={() => {}} onCancel={() => {}} />);
    const styles = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    expect(styles).toMatch(/\.cm-cursor[^{}]*\{[^}]*border-left-color\s*:\s*rgb\(\s*167\s*,\s*139\s*,\s*250\s*\)/);
  });
});
