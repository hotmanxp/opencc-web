// @vitest-environment happy-dom
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FsContentSearchList, highlightLine } from './FsContentSearchList.js';
import type { FsContentSearchEntry } from '../../../../shared/fs.js';

const sampleEntries: FsContentSearchEntry[] = [
  {
    path: 'src/foo.ts',
    name: 'foo.ts',
    matches: [
      { line: 42, text: '// TODO: refactor', submatch: { text: 'TODO', start: 3, end: 7 } },
    ],
  },
  {
    path: 'src/bar.ts',
    name: 'bar.ts',
    matches: [
      { line: 17, text: 'const TODO_LIST = []', submatch: { text: 'TODO', start: 6, end: 10 } },
    ],
  },
];

describe('highlightLine', () => {
  test('returns single node when submatch is empty (start === end)', () => {
    const out = highlightLine('hello', { start: 0, end: 0 });
    expect(out).toHaveLength(1);
    // Single Fragment with 'hello' text
    const text = String((out[0] as React.ReactElement).props?.children ?? '');
    expect(text).toBe('hello');
  });

  test('splits around the submatch range into 3 nodes', () => {
    const out = highlightLine('// TODO: refactor', { start: 3, end: 7 });
    expect(out).toHaveLength(3);
    // Reconstruct full text by reading .props.children from each Fragment/span
    const text = out.map((n) => {
      const el = n as React.ReactElement;
      return String(el.props?.children ?? '');
    }).join('');
    expect(text).toBe('// TODO: refactor');
  });

  test('clamps negative or out-of-range offsets to single node', () => {
    const out = highlightLine('foo', { start: -1, end: 99 });
    expect(out).toHaveLength(1);
    const text = String((out[0] as React.ReactElement).props?.children ?? '');
    expect(text).toBe('foo');
  });
});

describe('FsContentSearchList', () => {
  test('renders empty hint when entries=[]', () => {
    render(
      <FsContentSearchList
        entries={[]}
        loading={false}
        error={null}
        truncated={false}
        query="nope"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId('fs-content-empty')).toBeTruthy();
  });

  test('renders one row per entry with path:line + preview text', () => {
    render(
      <FsContentSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={false}
        query="TODO"
        onSelect={() => {}}
      />,
    );
    const rows = screen.getAllByTestId('fs-content-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-path')).toBe('src/foo.ts');
    expect(rows[0].getAttribute('data-line')).toBe('42');
    expect(rows[0].textContent).toContain('// TODO: refactor');
  });

  test('clicking a row fires onSelect with that path and line', () => {
    const onSelect = vi.fn();
    render(
      <FsContentSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={false}
        query="TODO"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getAllByTestId('fs-content-row')[0]);
    expect(onSelect).toHaveBeenCalledWith('src/foo.ts', 42);
  });

  test('shows loading spinner when loading and no entries', () => {
    render(
      <FsContentSearchList
        entries={[]}
        loading={true}
        error={null}
        truncated={false}
        query="TODO"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId('fs-content-loading')).toBeTruthy();
  });

  test('shows error placeholder when error is non-null', () => {
    render(
      <FsContentSearchList
        entries={[]}
        loading={false}
        error="ripgrep 未安装,内容搜索不可用"
        truncated={false}
        query="TODO"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId('fs-content-error')).toBeTruthy();
    expect(screen.getByText(/ripgrep/)).toBeTruthy();
  });

  test('shows truncated tail when truncated=true', () => {
    render(
      <FsContentSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={true}
        query="TODO"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId('fs-content-truncated')).toBeTruthy();
  });
});
