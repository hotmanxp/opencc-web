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
});
